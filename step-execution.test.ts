import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  resolveStepExecution,
  stepExecutionSchema,
} from "./step-execution";

type Sdk = BbPluginApi["sdk"];

const provider = (id: string, available = true) => ({
  id,
  available,
});

const model = (overrides: Record<string, unknown> = {}) => ({
  id: "model-id",
  model: "model-canonical",
  displayName: "Model",
  description: "Test model",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium" as const, description: "Balanced" },
    { reasoningEffort: "high" as const, description: "Deep" },
  ],
  defaultReasoningEffort: "medium" as const,
  isDefault: true,
  ...overrides,
});

const skill = (
  id: string,
  name: string,
  provider: "codex" | "claude-code" | "acp-cursor" | null = null,
) => ({
  id,
  name,
  filePath: `/skills/${name}/SKILL.md`,
  provider,
});

function makeSdk(options: {
  providers?: Array<{ id: string; available: boolean }>;
  models?: Array<Record<string, unknown>>;
  selectedOnlyModels?: Array<Record<string, unknown>>;
  modelLoadError?: Record<string, unknown> | null;
  skills?: Array<Record<string, unknown>>;
}) {
  const calls: Array<{ area: string; args: Record<string, unknown> }> = [];
  const sdk = {
    providers: {
      models: async (args: Record<string, unknown>) => {
        calls.push({ area: "providers.models", args });
        return {
          providers: options.providers ?? [provider("codex")],
          permissionCeiling: "full" as const,
          models: options.models ?? [model()],
          selectedOnlyModels: options.selectedOnlyModels ?? [],
          modelLoadError: options.modelLoadError ?? null,
        };
      },
    },
    skills: {
      list: async (args: Record<string, unknown>) => {
        calls.push({ area: "skills.list", args });
        return { skills: options.skills ?? [] };
      },
    },
  } as unknown as Sdk;
  return { sdk, calls };
}

const validChoice = {
  providerId: "codex",
  model: "model-id",
  reasoningLevel: "high" as const,
  skills: ["safe-skill", "skill_shared"],
  reason: "The task needs the approved coding harness.",
};

describe("step execution schema", () => {
  it("accepts a bounded strict choice", () => {
    expect(stepExecutionSchema.parse(validChoice)).toEqual(validChoice);
  });

  it("rejects unknown fields and oversized values", () => {
    expect(
      stepExecutionSchema.safeParse({ ...validChoice, extra: true }).success,
    ).toBe(false);
    expect(
      stepExecutionSchema.safeParse({
        ...validChoice,
        providerId: "p".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      stepExecutionSchema.safeParse({
        ...validChoice,
        skills: Array.from({ length: 9 }, (_, index) => `skill-${index}`),
      }).success,
    ).toBe(false);
    expect(
      stepExecutionSchema.safeParse({
        ...validChoice,
        reason: "r".repeat(1025),
      }).success,
    ).toBe(false);
  });
});

describe("resolveStepExecution", () => {
  it("does not silently fall back when the preferred model is unavailable", async () => {
    const fixture = makeSdk({ providers: [provider("codex"), provider("claude-code")] });
    await expect(resolveStepExecution(fixture.sdk,
      { environmentId: "env", projectId: "project" },
      { ...validChoice, skills: [] },
      { providerId: "claude-code", model: "claude-fable-5-1" },
    )).rejects.toThrow(/not available in the live catalog/);
    expect(fixture.calls[0]!.args.providerId).toBe("claude-code");
  });

  it("rejects a blank override reason and retains an explicit alternative reason", async () => {
    expect(stepExecutionSchema.safeParse({ ...validChoice, modelOverrideReason: "  " }).success).toBe(false);
    const fixture = makeSdk({});
    const reason = "The preferred provider is unavailable; this bounded check can use Codex.";
    const selected = await resolveStepExecution(fixture.sdk,
      { environmentId: "env", projectId: "project" },
      { ...validChoice, skills: [], modelOverrideReason: reason },
      { providerId: "claude-code", model: "claude-fable-5-1" },
    );
    expect(selected).toMatchObject({ providerId: "codex", model: "model-canonical", modelOverrideReason: reason });
  });

  it("routes both catalog lookups and returns exact provider, model, skills, and reason", async () => {
    const fixture = makeSdk({
      skills: [skill("skill_shared", "shared-skill"), skill("skill_safe", "safe-skill", "codex")],
    });

    const result = await resolveStepExecution(
      fixture.sdk,
      { environmentId: "environment-one", projectId: "project-one" },
      validChoice,
    );

    expect(result).toEqual({
      providerId: "codex",
      model: "model-canonical",
      reasoningLevel: "high",
      selectedSkills: [
        {
          id: "skill_safe",
          name: "safe-skill",
          filePath: "/skills/safe-skill/SKILL.md",
        },
        {
          id: "skill_shared",
          name: "shared-skill",
          filePath: "/skills/shared-skill/SKILL.md",
        },
      ],
      reason: validChoice.reason,
    });
    expect(fixture.calls).toContainEqual({
      area: "providers.models",
      args: { environmentId: "environment-one", providerId: "codex" },
    });
    expect(fixture.calls).toContainEqual({
      area: "skills.list",
      args: { environmentId: "environment-one", projectId: "project-one" },
    });
  });

  it("rejects an unknown or unavailable provider without selecting another", async () => {
    const unknown = makeSdk({ providers: [provider("codex")] });
    await expect(
      resolveStepExecution(
        unknown.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, providerId: "missing-provider" },
      ),
    ).rejects.toThrow(/provider.*missing-provider.*(available|known|catalog)/iu);

    const unavailable = makeSdk({ providers: [provider("codex", false)] });
    await expect(
      resolveStepExecution(
        unavailable.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        validChoice,
      ),
    ).rejects.toThrow(/provider.*codex.*unavailable/iu);
  });

  it("rejects a missing active model and ignores a retired model", async () => {
    const fixture = makeSdk({
      models: [],
      selectedOnlyModels: [model({ id: "retired-id", model: "retired-model" })],
    });

    await expect(
      resolveStepExecution(
        fixture.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, model: "retired-model" },
      ),
    ).rejects.toThrow(/model.*retired-model.*(available|catalog)/iu);
  });

  it("rejects duplicate matching catalog items even when their canonical model is equal", async () => {
    const fixture = makeSdk({
      models: [model(), model({ id: "another-id" })],
    });

    await expect(
      resolveStepExecution(
        fixture.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, model: "model-canonical", skills: [] },
      ),
    ).rejects.toThrow(/model.*ambiguous/iu);
  });

  it("rejects an unsupported reasoning level", async () => {
    const fixture = makeSdk({
      models: [
        model({
          supportedReasoningEfforts: [
            { reasoningEffort: "medium" as const, description: "Balanced" },
          ],
        }),
      ],
    });

    await expect(
      resolveStepExecution(
        fixture.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        validChoice,
      ),
    ).rejects.toThrow(/reasoning.*high.*support/iu);
  });

  it("resolves a skill by id or name, rejects missing and ambiguous names", async () => {
    const missing = makeSdk({ skills: [skill("skill_safe", "safe-skill", "codex")] });
    await expect(
      resolveStepExecution(
        missing.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, skills: ["does-not-exist"] },
      ),
    ).rejects.toThrow(/skill.*does-not-exist.*(missing|found)/iu);

    const ambiguous = makeSdk({
      skills: [
        skill("skill_one", "same-name", "codex"),
        skill("skill_two", "same-name", "codex"),
      ],
    });
    await expect(
      resolveStepExecution(
        ambiguous.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, skills: ["same-name"] },
      ),
    ).rejects.toThrow(/skill.*same-name.*ambiguous/iu);
  });

  it("rejects provider-incompatible skills and duplicate canonical selections", async () => {
    const incompatible = makeSdk({
      skills: [skill("skill_claude", "claude-only", "claude-code")],
    });
    await expect(
      resolveStepExecution(
        incompatible.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, skills: ["claude-only"] },
      ),
    ).rejects.toThrow(/skill.*claude-only.*codex|incompatible/iu);

    const duplicate = makeSdk({
      skills: [skill("skill_safe", "safe-skill", "codex")],
    });
    await expect(
      resolveStepExecution(
        duplicate.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        { ...validChoice, skills: ["safe-skill", "skill_safe"] },
      ),
    ).rejects.toThrow(/skill.*duplicate/iu);
  });

  it("rejects an unavailable model catalog instead of using a fallback", async () => {
    const fixture = makeSdk({
      modelLoadError: { providerId: "codex", code: "timeout" },
    });

    await expect(
      resolveStepExecution(
        fixture.sdk,
        { environmentId: "environment-one", projectId: "project-one" },
        validChoice,
      ),
    ).rejects.toThrow(/model.*catalog.*unavailable/iu);
  });
});
