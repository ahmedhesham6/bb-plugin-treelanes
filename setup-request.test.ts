import { describe, expect, it } from "vitest";
import { taskContextSchema } from "./stage-evidence";
import type { SetupPlan, SetupStep } from "./setup-plan";
import {
  buildSetupPrompt,
  setupProposalSchema,
  validateSetupProposal,
} from "./setup-request";

const execution = {
  providerId: "codex",
  model: "gpt-test",
  reasoningLevel: "medium" as const,
  skills: ["delivery"],
  reason: "The catalog supports this bounded worker.",
};

function step(
  id: string,
  overrides: Partial<SetupStep> = {},
): SetupStep {
  return {
    id,
    title: `Step ${id}`,
    stage: "tdd",
    instructions: `Complete ${id}.`,
    checks: ["global check"],
    execution,
    ...overrides,
  };
}

function plan(steps: SetupStep[]): SetupPlan {
  return { summary: "A bounded setup.", steps };
}

function task(
  overrides: Partial<ReturnType<typeof taskContextSchema.parse>> = {},
) {
  return taskContextSchema.parse({
    outcome: "Complete the requested change.",
    scope: ["src/feature.ts"],
    decisions: ["Keep the public API stable."],
    requiredChecks: ["global check"],
    allowedActions: ["Edit and test scoped files."],
    ...overrides,
  });
}

describe("setup proposal contract", () => {
  it("accepts only a strict setup envelope", () => {
    const setup = plan([step("first")]);

    expect(setupProposalSchema.parse({ setup })).toEqual({ setup });
    for (const field of ["task", "scope", "permissions"]) {
      expect(
        setupProposalSchema.safeParse({ setup, [field]: "must not be accepted" })
          .success,
      ).toBe(false);
    }
  });

  it("requires the first step to use the current operational stage", () => {
    expect(() => validateSetupProposal(task(), plan([step("first")]), "quality", null, false))
      .toThrow(/first.*stage/i);
    expect(() => validateSetupProposal(task(), plan([step("first")]), "tdd", null, false))
      .not.toThrow();
  });

  it("rejects legacy delivery stages and an over-budget additive check set", () => {
    expect(() => validateSetupProposal(
      task({ deliveryStages: ["tdd", "quality", "pr"] }),
      plan([step("first")]),
      "tdd",
      null,
      false,
    )).toThrow(/legacy.*deliveryStages|deliveryStages.*legacy/i);

    const checks = Array.from({ length: 128 }, (_, index) => `required-${index}`);
    expect(() => validateSetupProposal(
      task({ requiredChecks: checks }),
      plan([step("first", { checks: ["new check"] })]),
      "tdd",
      null,
      false,
    )).toThrow(/128.*checks|checks.*128/i);
  });

  it("keeps the completed prefix and active step position during recovery", () => {
    const previous = task({
      setup: plan([
        step("done"),
        step("active", { checks: ["global check", "active check"] }),
        step("future"),
      ]),
    });
    const proposed = plan([
      structuredClone(previous.setup!.steps[0]!),
      step("active", { checks: ["global check", "active check", "new active check"] }),
      step("replacement"),
      step("new-future", { stage: "quality" }),
    ]);

    expect(() => validateSetupProposal(previous, proposed, "tdd", "active", true))
      .not.toThrow();

    const moved = plan([proposed.steps[1]!, proposed.steps[0]!, proposed.steps[2]!]);
    expect(() => validateSetupProposal(previous, moved, "tdd", "active", true))
      .toThrow(/completed.*prefix|position|current setup step/i);

    const missingCheck = structuredClone(proposed);
    missingCheck.steps[1]!.checks = ["global check"];
    expect(() => validateSetupProposal(previous, missingCheck, "tdd", "active", true))
      .toThrow(/check/i);

    expect(() => validateSetupProposal(previous, proposed, "quality", "active", true))
      .toThrow(/stage/i);
    expect(() => validateSetupProposal(previous, proposed, "tdd", "missing", true))
      .toThrow(/active|current setup step/i);
  });

  it("requires setup and an active ID for recovery", () => {
    expect(() => validateSetupProposal(task(), plan([step("first")]), "tdd", "first", true))
      .toThrow(/previous.*setup|setup.*recovery/i);
    const previous = task({ setup: plan([step("first")]) });
    expect(() => validateSetupProposal(previous, plan([step("first")]), "tdd", null, true))
      .toThrow(/active/i);
  });
});

describe("setup worker prompt", () => {
  it("names the bounded setup-only APIs and carries the task inputs", () => {
    const prompt = buildSetupPrompt({
      task: task({ constraints: ["Use the requested provider and model exactly."] }),
      stage: "tdd",
      activeStepId: null,
      recoveryReason: null,
      catalog: { providers: ["codex"], models: ["gpt-test"], skills: ["delivery"] },
      playbooks: [{ summary: "A checked setup" }],
    });

    expect(prompt).toContain("workflow_board_apply_setup");
    expect(prompt).toContain("workflow_board_catalog");
    expect(prompt).toContain("setup-only");
    expect(prompt).toMatch(/do not edit files|no file edits/i);
    expect(prompt).toMatch(/permission.*inherit/i);
    expect(prompt).toContain("Use the requested provider and model exactly.");
    expect(prompt).toContain("gpt-test");
    expect(prompt).toMatch(/model defaults|do not.*model.*default/i);
  });

  it("bounds untrusted catalog and playbook text", () => {
    const prompt = buildSetupPrompt({
      task: task(),
      stage: "tdd",
      activeStepId: "active",
      recoveryReason: "r".repeat(20_000),
      catalog: { noisy: "c".repeat(100_000) },
      playbooks: { noisy: "p".repeat(100_000) },
    });

    expect(prompt.length).toBeLessThanOrEqual(32_768);
    expect(prompt).toContain("workflow_board_apply_setup");
    expect(prompt).toContain("workflow_board_catalog");
  });
});
