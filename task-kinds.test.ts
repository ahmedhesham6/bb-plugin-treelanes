import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSetupPrompt } from "./setup-request";
import { taskContextSchema } from "./stage-evidence";
import { kindTemplate } from "./task-kinds";
import { shippedSkills } from "./test-workspace";

const kinds = ["feature", "bug-fix", "refactor", "perf"] as const;
const task = (kind?: unknown) => ({ outcome: "Change it.", scope: ["a.ts"], decisions: [], requiredChecks: ["npm test"],
  allowedActions: ["Edit a.ts."], ...(kind === undefined ? {} : { kind }) });
// The catalog ID bb gives a skill in this plugin's skills/ folder.
const catalogId = (name: string) =>
  `skill_${createHash("sha256").update(`bb-plugin:workflow-board\0${name}/SKILL.md`).digest("hex")}`;

describe("task kinds", () => {
  it("accepts the four kinds and a task without a kind", () => {
    for (const kind of kinds) expect(taskContextSchema.parse(task(kind)).kind).toBe(kind);
    expect(taskContextSchema.parse(task()).kind).toBeUndefined();
    expect(taskContextSchema.safeParse(task("hillclimb")).success).toBe(false);
  });

  it("orders each kind's template steps and adds PR Watch only for PR delivery", () => {
    const ids = (kind: (typeof kinds)[number], deliveryTarget?: "pr" | "local") =>
      kindTemplate({ kind, deliveryTarget }).map(step => step.id);
    expect(ids("feature")).toEqual(["build", "quality", "simplify"]);
    expect(ids("bug-fix")).toEqual(["reproduce", "root-cause", "fix", "quality", "simplify"]);
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
    expect(kindTemplate({ kind: "bug-fix" })[0]!.skills).toEqual([catalogId("diagnosing-bugs"), catalogId("principle-fix-root-causes")]);
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
});
