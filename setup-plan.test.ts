import { describe, expect, it } from "vitest";
import { setupPlanSchema, validateSetupRevision, preserveCompletedSteps } from "./setup-plan";

const step = (id: string) => ({ id, title: id, stage: "tdd" as const, instructions: `Do ${id}`, checks: ["Regression"],
  execution: { providerId: "codex", model: "small", reasoningLevel: "low" as const, skills: [], reason: "Bounded work" } });
const plan = { summary: "Three checks", steps: [step("first"), step("current"), step("last")] };

describe("setup changes", () => {
  it("preserves saved completed records while accepting a rewritten summary and a new PR step", () => {
    const changed = structuredClone(plan);
    changed.steps[0]!.instructions = "Use the prior receipt; this step is complete";
    changed.steps[0]!.checks = ["Short summary"];
    const candidate = { ...changed, steps: [...changed.steps, { ...step("watch"), stage: "pr" as const }] };
    const normalized = preserveCompletedSteps(plan, candidate, "current");
    expect(normalized!.steps[0]).toEqual(plan.steps[0]);
    expect(normalized!.steps.at(-1)!.stage).toBe("pr");
    expect(() => validateSetupRevision(plan, normalized, "current", "tdd", true)).not.toThrow();
    expect(candidate.steps[0]!.instructions).toContain("prior receipt");
  });

  it("allows replacement of future work while preserving completed steps", () => {
    expect(() => validateSetupRevision(plan, { ...plan, steps: [...plan.steps.slice(0, 2), step("new")] }, "current", "tdd", true)).not.toThrow();
    const changed = structuredClone(plan); changed.steps[0]!.instructions = "Different work";
    expect(() => validateSetupRevision(plan, changed, "current", "tdd", true)).toThrow(/Completed/);
    expect(() => validateSetupRevision(plan, { ...plan, steps: plan.steps.slice(1) }, "current", "tdd", true)).toThrow(/Keep/);
  });
  it("rejects a missing current step and a first step in another stage", () => {
    expect(() => validateSetupRevision(plan, undefined, "current", "tdd", true)).toThrow();
    expect(() => validateSetupRevision(undefined, plan, null, "quality", false)).toThrow(/first/);
  });
  it("accepts a skipped list with reasons", () => {
    expect(setupPlanSchema.parse({ ...plan, skipped: [{ stepId: "simplify", reason: "One-line change" }] }).skipped)
      .toEqual([{ stepId: "simplify", reason: "One-line change" }]);
  });
  it.each([
    { ...plan, skipped: [{ stepId: "simplify", reason: " " }] },
    { ...plan, skipped: [{ stepId: "first", reason: "Both kept and skipped" }] },
    { ...plan, steps: [step("duplicate"), step("duplicate")] },
    { ...plan, steps: [{ ...step("first"), stage: "pr" }, step("last")] },
    { ...plan, steps: [{ ...step("unchecked"), checks: [] }] },
    { ...plan, steps: Array.from({ length: 25 }, (_, index) => step(`step${index}`)) },
  ])("rejects an invalid or unbounded setup", candidate => {
    expect(setupPlanSchema.safeParse(candidate).success).toBe(false);
  });
});
