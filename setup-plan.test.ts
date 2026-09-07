import { describe, expect, it } from "vitest";
import { setupPlanSchema, validateSetupRevision } from "./setup-plan";

const step = (id: string) => ({ id, title: id, stage: "tdd" as const, instructions: `Do ${id}`, checks: ["Regression"],
  execution: { providerId: "codex", model: "small", reasoningLevel: "low" as const, skills: [], reason: "Bounded work" } });
const plan = { summary: "Three checks", steps: [step("first"), step("current"), step("last")] };

describe("setup changes", () => {
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
  it.each([
    { ...plan, steps: [step("duplicate"), step("duplicate")] },
    { ...plan, steps: [{ ...step("first"), stage: "pr" }, step("last")] },
    { ...plan, steps: [{ ...step("unchecked"), checks: [] }] },
    { ...plan, steps: Array.from({ length: 25 }, (_, index) => step(`step${index}`)) },
  ])("rejects an invalid or unbounded setup", candidate => {
    expect(setupPlanSchema.safeParse(candidate).success).toBe(false);
  });
});
