import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SetupStep } from "./setup-plan";
import { kindSteps, TASK_KINDS, type TaskKind } from "./task-kinds";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
type Sdk = BbPluginApi["sdk"];

/**
 * A saved Execution Choice for one task map slot. Each level needs the one
 * before it: an effort belongs to a model, a model to a harness. A missing
 * field means the orchestrator chooses.
 */
const name = z.string().min(1).max(128);
export const choiceSchema = z.object({ providerId: name.optional(), model: name.optional(), reasoningLevel: name.optional() }).strict()
  .refine(choice => (!choice.model || choice.providerId) && (!choice.reasoningLevel || choice.model), "An effort needs a model, and a model needs a harness.");
export type Choice = z.infer<typeof choiceSchema>;

/** Slots are "orchestrator", "titles" and "<kind>/<step id>". */
export const choicesSchema = z.record(z.string().min(1).max(128), choiceSchema);
export type Choices = Record<string, Choice>;

export const taskMapMigration = `CREATE TABLE task_map_choices (
  slot TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT, reasoning_level TEXT
)`;

/** The rows Settings shows, built from the task kind templates. */
export function taskMapLayout() {
  return {
    shared: [
      { slot: "orchestrator", title: "Orchestrator", detail: "Plans the task setup in the initiating thread." },
      { slot: "titles", title: "Automatic titles", detail: "Writes short sidebar titles when automatic titles are on." },
    ],
    kinds: TASK_KINDS.map(kind => ({
      kind,
      steps: kindSteps(kind, "pr").map(step => ({
        slot: `${kind}/${step.id}`, id: step.id, stage: step.stage, title: step.title,
        checks: step.checks, skills: step.skills, prOnly: step.stage === "pr",
      })),
    })),
  };
}

export function taskMapStore(db: Db) {
  function read(): Choices {
    const rows = db.prepare("SELECT slot, provider_id, model, reasoning_level FROM task_map_choices").all() as
      { slot: string; provider_id: string; model: string | null; reasoning_level: string | null }[];
    return Object.fromEntries(rows.map(row => [row.slot, {
      providerId: row.provider_id, ...(row.model ? { model: row.model } : {}),
      ...(row.model && row.reasoning_level ? { reasoningLevel: row.reasoning_level } : {}),
    }]));
  }
  const save = db.transaction((choices: Choices) => {
    db.prepare("DELETE FROM task_map_choices").run();
    const put = db.prepare("INSERT INTO task_map_choices VALUES (?, ?, ?, ?)");
    for (const [slot, choice] of Object.entries(choices)) {
      if (choice.providerId) put.run(slot, choice.providerId, choice.model ?? null, choice.reasoningLevel ?? null);
    }
  });
  return { read, save: (choices: Choices) => save(choicesSchema.parse(choices)) };
}

/** Saved choices for the template steps of a task's kind, by step ID. */
export function stepChoices(kind: TaskKind | undefined, choices: Choices): Choices {
  if (!kind) return {};
  return Object.fromEntries(Object.entries(choices).flatMap(([slot, choice]) =>
    slot.startsWith(`${kind}/`) ? [[slot.slice(kind.length + 1), choice]] : []));
}

/** Reject a template step that differs from its saved Settings choice. */
export function requireStepChoices(kind: TaskKind | undefined, steps: SetupStep[], choices: Choices): void {
  for (const [stepId, choice] of Object.entries(stepChoices(kind, choices))) {
    const step = steps.find(candidate => candidate.id === stepId);
    if (!step) continue;
    for (const field of ["providerId", "model", "reasoningLevel"] as const) {
      if (choice[field] && step.execution[field] !== choice[field]) {
        throw new Error(`Template step ${JSON.stringify(stepId)} must use ${field} ${JSON.stringify(choice[field])} from the Settings task map.`);
      }
    }
  }
}

/** Live harnesses, their models and efforts, and every saved choice they cannot run. */
export async function liveCatalog(sdk: Sdk, choices: Choices) {
  const providers = await sdk.providers.list();
  const models = Object.fromEntries(await Promise.all(providers.filter(provider => provider.available).map(async provider => {
    const result = await sdk.providers.models({ providerId: provider.id }).catch(() => null);
    return [provider.id, result && !result.modelLoadError ? result.models.map(model => ({
      model: model.model, name: model.displayName,
      efforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort as string),
    })) : null] as const;
  })));
  const problems = Object.entries(choices).flatMap(([slot, choice]) => {
    const provider = providers.find(candidate => candidate.id === choice.providerId);
    const providerModels = provider ? models[provider.id] : undefined;
    const model = providerModels?.find(candidate => candidate.model === choice.model);
    const message = !provider?.available ? `Harness ${choice.providerId} is not available.`
      : choice.model && providerModels === null ? `Models for ${choice.providerId} could not load.`
      : choice.model && !model ? `Model ${choice.model} is not available for ${choice.providerId}.`
      : choice.reasoningLevel && !model?.efforts.includes(choice.reasoningLevel) ? `Effort ${choice.reasoningLevel} is not supported by ${choice.model}.`
      : null;
    return message ? [{ slot, message }] : [];
  });
  return {
    providers: providers.map(provider => ({ id: provider.id, name: provider.displayName, available: provider.available })),
    models, problems,
  };
}
