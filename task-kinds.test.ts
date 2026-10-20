import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SetupPlan } from "./setup-plan";
import { buildSetupPrompt, validateSetupProposal } from "./setup-request";
import { taskContextSchema } from "./stage-evidence";
import { kindTemplate, validateKindSteps } from "./task-kinds";
import { shippedSkills } from "./test-workspace";

const kinds = ["feature", "bug-fix", "refactor", "perf"] as const;
const task = (kind?: unknown) => ({ outcome: "Change it.", scope: ["a.ts"], decisions: [], requiredChecks: ["npm test"],
  allowedActions: ["Edit a.ts."], ...(kind === undefined ? {} : { kind }) });
// The catalog ID bb gives a skill in this plugin's skills/ folder.
const catalogId = (name: string) =>
  `skill_${createHash("sha256").update(`bb-plugin:treelanes\0${name}/SKILL.md`).digest("hex")}`;

describe("task kinds", () => {
  it("accepts the four kinds and a task without a kind", () => {
    for (const kind of kinds) expect(taskContextSchema.parse(task(kind)).kind).toBe(kind);
    expect(taskContextSchema.parse(task()).kind).toBeUndefined();
    expect(taskContextSchema.safeParse(task("hillclimb")).success).toBe(false);
  });

  it("orders each kind's template steps and adds PR Watch only for PR delivery", () => {
    const ids = (kind: (typeof kinds)[number], deliveryTarget?: "pr" | "local") =>
      kindTemplate({ kind, deliveryTarget }).map(step => step.id);
    expect(ids("feature")).toEqual(["build", "quality", "bug-hunt", "simplify"]);
    expect(ids("bug-fix")).toEqual(["reproduce", "root-cause", "fix", "quality", "bug-hunt", "simplify"]);
    expect(ids("refactor")).toEqual(["pin-behavior", "subtract", "reshape", "quality"]);
    expect(ids("perf", "local")).toEqual(["baseline", "fix", "measure", "quality"]);
    expect(ids("perf", "pr")).toEqual(["baseline", "fix", "measure", "quality", "pr"]);
    expect(kindTemplate({})).toEqual([]);
  });

  it("names only skills shipped in skills/ by their plugin catalog ID", () => {
    const shipped = new Set(shippedSkills.map(catalogId));
    for (const kind of kinds)
      for (const step of kindTemplate({ kind, deliveryTarget: "pr" }))
        for (const skill of step.skills) expect(shipped).toContain(skill);
    for (const kind of kinds) expect(kindTemplate({ kind, deliveryTarget: "pr" }).at(-1)!.skills).toContain(catalogId("pr-proof"));
    expect(kindTemplate({ kind: "bug-fix" })[0]!.skills).toEqual([catalogId("diagnosing-bugs"), catalogId("principle-fix-root-causes")]);
    // The ID a live bb catalog gave the shipped tdd skill of plugin treelanes.
    expect(kindTemplate({ kind: "feature" })[0]!.skills[0]).toBe("skill_be770585e3c00bb7048489911a88678935ab2249dae66ef8e36ce3243591a92c");
  });

  it.each(["feature", "bug-fix"] as const)("requires live call evidence and the bug-hunt skill for %s", kind => {
    const steps = kindTemplate({ kind });
    expect(steps.find(step => step.id === (kind === "feature" ? "build" : "fix"))!.checks).toContain(
      "Each external API the change calls answered one real request (sandbox, dev, or local stack), and the test fixture comes from that reply; or the PR's Not verified list names it with the post-merge check.",
    );
    expect(steps.find(step => step.id === "bug-hunt")!.skills).toEqual([catalogId("bug-hunt")]);
  });

  it("gives the setup worker the kind and every template step id, check and skill ID", () => {
    const input = { environmentId: "env", requestId: 1, taskRevision: 1, stage: "tdd", activeStepId: null, recoveryReason: null };
    for (const kind of kinds) {
      const prompt = buildSetupPrompt({ ...input, task: { kind } });
      expect(prompt).toContain(kind);
      for (const step of kindTemplate({ kind })) {
        expect(prompt).toContain(step.id);
        for (const value of [...step.checks, ...step.skills]) expect(prompt).toContain(value);
      }
    }
    expect(buildSetupPrompt(input)).not.toMatch(/template/i);
  });

  it.each(["local", "pr"] as const)("keeps step requirements and later prompts intact after template edits for %s delivery", deliveryTarget => {
    const input = { environmentId: "env", requestId: 1, taskRevision: 1, stage: "tdd", activeStepId: null,
      recoveryReason: null, task: { kind: "bug-fix" as const, deliveryTarget } };
    const prompt = buildSetupPrompt(input);
    const steps = kindTemplate(input.task);
    const rootCauseSkills = [...steps[1]!.skills];
    steps[0]!.skills.pop();
    expect(steps[1]!.skills).toEqual(rootCauseSkills);
    steps[0]!.checks.length = 0;
    steps[0]!.title = "Changed title";
    steps.at(-1)!.skills.length = 0;
    steps.length = 0;
    expect(buildSetupPrompt(input)).toBe(prompt);
  });
});

describe("kind template rules on a setup proposal", () => {
  const bugFix = taskContextSchema.parse(task("bug-fix"));
  const fromTemplate = (): SetupPlan => ({ summary: "Bug fix.", steps: kindTemplate(bugFix).map(({ skills, ...step }) =>
    ({ ...step, execution: { providerId: "codex", model: "m", reasoningLevel: "low", skills, reason: "Fits." } })) });
  const edit = (change: (plan: SetupPlan) => void) => { const plan = fromTemplate(); change(plan); return plan; };
  const extra = { ...fromTemplate().steps[0]!, id: "notes", title: "Write notes" };

  it("accepts the template with extra steps, checks and skills, and skips with a reason", () => {
    const plan = edit(plan => {
      plan.steps[2]!.checks.push("Extra check"); plan.steps[2]!.execution.skills.push("extra-skill");
      plan.steps.splice(3, 0, extra); plan.steps.pop(); plan.skipped = [{ stepId: "simplify", reason: "One-line fix." }];
    });
    expect(() => validateSetupProposal(bugFix, plan, "tdd", null, false)).not.toThrow();
  });

  it.each([
    ["a missing step without a skip entry", (plan: SetupPlan) => { plan.steps.pop(); }, /simplify/],
    ["a skip entry outside the template", (plan: SetupPlan) => { plan.skipped = [{ stepId: "extra", reason: "Not needed." }]; }, /extra/],
    ["a changed stage", (plan: SetupPlan) => { plan.steps[1]!.stage = "quality"; }, /root-cause.*stage/],
    ["a dropped check", (plan: SetupPlan) => { plan.steps[2]!.checks = ["Another check"]; }, /fix.*check/],
    ["a dropped skill", (plan: SetupPlan) => { plan.steps[0]!.execution.skills.pop(); }, /reproduce.*skill/],
    ["out-of-order steps", (plan: SetupPlan) => { plan.steps.splice(0, 2, plan.steps[1]!, plan.steps[0]!); }, /order/],
  ])("rejects %s", (_, change, message) => {
    expect(() => validateSetupProposal(bugFix, edit(change), "tdd", null, false)).toThrow(message);
  });

  it("applies no kind rule without a kind", () => {
    const plan = edit(plan => { plan.steps = [extra]; });
    expect(() => validateSetupProposal(taskContextSchema.parse(task()), plan, "tdd", null, false)).not.toThrow();
  });

  it("applies in recovery", () => {
    const previous = { ...bugFix, setup: fromTemplate() };
    expect(() => validateSetupProposal(previous, fromTemplate(), "tdd", "root-cause", true)).not.toThrow();
    expect(() => validateSetupProposal(previous, edit(plan => { plan.steps.pop(); }), "tdd", "root-cause", true)).toThrow(/simplify/);
  });

  describe("on a plan saved under an older template", () => {
    const feature = taskContextSchema.parse({ ...task("feature"), deliveryTarget: "pr" });
    // Before bug-hunt, the live call check and pr-proof: build → quality → simplify → pr.
    const old = (): SetupPlan => ({ summary: "Feature.", steps: kindTemplate(feature).filter(step => step.id !== "bug-hunt")
      .map(({ skills, ...step }) => ({ ...step, checks: step.checks.slice(0, 1),
        execution: { providerId: "codex", model: "m", reasoningLevel: "low", skills: skills.filter(skill => skill !== catalogId("pr-proof")), reason: "Fits." } })) });

    it("keeps completed steps and the skills of a started step as they are", () => {
      expect(() => validateKindSteps(feature, old(), 3, true)).not.toThrow();
      expect(() => validateKindSteps(feature, old(), 0, true)).toThrow(/"build" must keep check/);
    });

    it("binds the template to steps that have not started", () => {
      expect(() => validateKindSteps(feature, old(), 2)).toThrow(/"pr" must keep required skill/);
      const plan = old();
      plan.steps[3]!.execution.skills.push(catalogId("pr-proof"));
      expect(() => validateKindSteps(feature, plan, 2)).not.toThrow();
      expect(() => validateKindSteps(feature, plan, 1, true)).toThrow(/bug-hunt/);
      expect(() => validateKindSteps(feature, plan)).toThrow(/"build" must keep check/);
    });

    it("lets recovery add the new required skill to the active step", () => {
      const plan = old();
      expect(() => validateSetupProposal({ ...feature, setup: old() }, plan, "pr", "pr", true)).toThrow(/"pr" must keep required skill/);
      plan.steps[3]!.execution.skills.push(catalogId("pr-proof"));
      expect(() => validateSetupProposal({ ...feature, setup: old() }, plan, "pr", "pr", true)).not.toThrow();
    });
  });
});
