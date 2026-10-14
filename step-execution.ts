import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MAX_NAME_LENGTH = 128;
const MAX_SKILLS = 8;
const MAX_REASON_LENGTH = 1_024;
const MAX_FILE_PATH_LENGTH = 4_096;

const REASONING_LEVELS = [
  "high",
  "low",
  "max",
  "medium",
  "none",
  "ultra",
  "ultracode",
  "xhigh",
] as const;

const boundedName = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const boundedReason = z.string().trim().min(1).max(MAX_REASON_LENGTH);

export const stepExecutionSchema = z
  .object({
    providerId: boundedName,
    model: boundedName,
    reasoningLevel: z.enum(REASONING_LEVELS),
    skills: z.array(boundedName).max(MAX_SKILLS),
    reason: boundedReason,
  })
  .strict();

export type StepExecutionChoice = z.infer<typeof stepExecutionSchema>;

type Sdk = BbPluginApi["sdk"];
type ModelCatalog = Awaited<ReturnType<Sdk["providers"]["models"]>>;
type ModelCatalogEntry = ModelCatalog["models"][number];
type SkillList = Awaited<ReturnType<Sdk["skills"]["list"]>>;
type SkillEntry = SkillList["skills"][number];
type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type SelectedStepSkill = Pick<SkillEntry, "id" | "name" | "filePath">;

export type ResolvedStepExecution = {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  selectedSkills: SelectedStepSkill[];
  reason: string;
};

export class StepExecutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StepExecutionError";
  }
}

function reject(message: string): never {
  throw new StepExecutionError(`Step execution selection rejected: ${message}`);
}

async function readSdk<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StepExecutionError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new StepExecutionError(
      `Step execution selection unavailable while reading ${label}: ${detail}`,
      { cause: error },
    );
  }
}

function assertLiveName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return reject(`${label} is missing from the live catalog`);
  }
  if (value.length > MAX_NAME_LENGTH) {
    return reject(`${label} exceeds ${MAX_NAME_LENGTH} characters`);
  }
  return value;
}

function assertLivePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return reject(`${label} is missing from the live catalog`);
  }
  if (value.length > MAX_FILE_PATH_LENGTH) {
    return reject(`${label} exceeds ${MAX_FILE_PATH_LENGTH} characters`);
  }
  return value;
}

function matchingModels(
  models: readonly ModelCatalogEntry[],
  requestedModel: string,
): ModelCatalogEntry[] {
  return models.filter(
    (catalogModel) =>
      catalogModel.id === requestedModel ||
      catalogModel.model === requestedModel,
  );
}

function resolveModel(
  catalog: ModelCatalog,
  choice: StepExecutionChoice,
): ModelCatalogEntry {
  const providerMatches = catalog.providers.filter(
    (provider) => provider.id === choice.providerId,
  );
  if (providerMatches.length === 0) {
    reject(`provider ${JSON.stringify(choice.providerId)} is not available`);
  }
  if (providerMatches.length > 1) {
    reject(`provider ${JSON.stringify(choice.providerId)} is ambiguous`);
  }
  if (!providerMatches[0]?.available) {
    reject(`provider ${JSON.stringify(choice.providerId)} is unavailable`);
  }

  if (catalog.modelLoadError !== null) {
    reject(
      `model catalog for provider ${JSON.stringify(choice.providerId)} is unavailable (${catalog.modelLoadError.code})`,
    );
  }

  const matches = matchingModels(catalog.models, choice.model);
  if (matches.length === 0) {
    reject(`model ${JSON.stringify(choice.model)} is not available in the live catalog`);
  }
  if (matches.length > 1) {
    reject(`model ${JSON.stringify(choice.model)} is ambiguous in the live catalog`);
  }
  const selectedModel = matches[0];
  if (selectedModel === undefined) {
    return reject(`model ${JSON.stringify(choice.model)} is missing`);
  }
  assertLiveName(selectedModel.id, "model id");
  assertLiveName(selectedModel.model, "canonical model");
  return selectedModel;
}

function assertReasoningSupported(
  selectedModel: ModelCatalogEntry,
  reasoningLevel: ReasoningLevel,
): void {
  const matches = selectedModel.supportedReasoningEfforts.filter(
    (effort) => effort.reasoningEffort === reasoningLevel,
  );
  if (matches.length === 0) {
    reject(
      `reasoning level ${JSON.stringify(reasoningLevel)} is not supported by model ${JSON.stringify(selectedModel.model)}`,
    );
  }
  if (matches.length > 1) {
    reject(
      `reasoning level ${JSON.stringify(reasoningLevel)} is ambiguous for model ${JSON.stringify(selectedModel.model)}`,
    );
  }
}

function resolveSkills(
  skillList: SkillList,
  choice: StepExecutionChoice,
): SelectedStepSkill[] {
  const selectedSkills: SelectedStepSkill[] = [];
  const selectedIds = new Set<string>();

  for (const requestedSkill of choice.skills) {
    const matches = skillList.skills.filter(
      (skill) => skill.id === requestedSkill || skill.name === requestedSkill,
    );
    if (matches.length === 0) {
      reject(`skill ${JSON.stringify(requestedSkill)} is missing from the live catalog`);
    }
    if (matches.length > 1) {
      reject(`skill ${JSON.stringify(requestedSkill)} is ambiguous in the live catalog`);
    }
    const selectedSkill = matches[0];
    if (selectedSkill === undefined) {
      return reject(`skill ${JSON.stringify(requestedSkill)} is missing`);
    }
    const skillId = assertLiveName(selectedSkill.id, "skill id");
    const skillName = assertLiveName(selectedSkill.name, "skill name");
    const filePath = assertLivePath(selectedSkill.filePath, "skill file path");
    if (
      selectedSkill.provider !== null &&
      selectedSkill.provider !== choice.providerId
    ) {
      reject(
        `skill ${JSON.stringify(requestedSkill)} is incompatible with provider ${JSON.stringify(choice.providerId)}`,
      );
    }
    if (selectedIds.has(skillId)) {
      reject(`skill ${JSON.stringify(requestedSkill)} is a duplicate selection`);
    }
    selectedIds.add(skillId);
    selectedSkills.push({ id: skillId, name: skillName, filePath });
  }

  return selectedSkills;
}

export async function resolveStepExecution(
  sdk: BbPluginApi["sdk"],
  routing: { environmentId: string; projectId: string },
  choice: StepExecutionChoice,
): Promise<ResolvedStepExecution> {
  const parsedChoice = stepExecutionSchema.parse(choice);
  if (routing.environmentId.length === 0) {
    reject("environmentId is required");
  }
  if (routing.projectId.length === 0) {
    reject("projectId is required");
  }

  const [catalog, skillList] = await Promise.all([
    readSdk("provider model catalog", () =>
      sdk.providers.models({
        environmentId: routing.environmentId,
        providerId: parsedChoice.providerId,
      }),
    ),
    readSdk("project skill catalog", () =>
      sdk.skills.list({
        environmentId: routing.environmentId,
        projectId: routing.projectId,
      }),
    ),
  ]);

  const selectedModel = resolveModel(catalog, parsedChoice);
  assertReasoningSupported(selectedModel, parsedChoice.reasoningLevel);
  const selectedSkills = resolveSkills(skillList, parsedChoice);

  return {
    providerId: parsedChoice.providerId,
    model: selectedModel.model,
    reasoningLevel: parsedChoice.reasoningLevel,
    selectedSkills,
    reason: parsedChoice.reason,
  };
}
