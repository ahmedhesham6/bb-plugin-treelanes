import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { requiredStageChecks } from "./delivery-plan";
import { setupPlanSchema, type SetupPlan, type SetupStep } from "./setup-plan";
import type { TaskContext } from "./stage-evidence";

const operationalStages = new Set(["tdd", "quality", "simplify", "pr"]);
const MAX_PROMPT_LENGTH = 32_768;
const MAX_TASK_TEXT = 12_000;
const MAX_CATALOG_TEXT = 6_000;
const MAX_PLAYBOOK_TEXT = 6_000;
const MAX_RECOVERY_REASON = 2_048;

export const setupProposalSchema = z
  .object({ setup: setupPlanSchema })
  .strict();

const SETUP_WORKER_INSTRUCTIONS = [
  "You are a setup-only worker for Workflow Board.",
  "Plan work only. Do not implement the task.",
  "Do not edit files, move board cards, dispatch workers, or submit a completion receipt.",
  "Read repository instructions and check definitions if useful.",
  "Read current state with workflow_board_get_context when needed.",
  "Return the plan through workflow_board_apply_setup {setup}.",
  "Choose live provider IDs, model IDs or canonical model names, supported reasoning efforts, and skill IDs.",
  "Call workflow_board_catalog when provider, model, reasoning-effort, or skill information is missing.",
  "Use the smallest complete bounded plan that satisfies the task.",
  "Preserve every user constraint, including explicit provider and model requests, required checks, and accepted decisions.",
  "Do not invent authority or confirmations.",
  "Do not use model defaults or fill in missing execution choices by guesswork.",
  "The parent restricts permission inheritance. Do not request, widen, or infer permission settings.",
  "Output a plan only, not implementation work. If the task cannot be fulfilled with the available information, return a blocker instead of guessing.",
].join("\n");

function reject(message: string): never {
  throw new Error(`Setup proposal rejected: ${message}`);
}

function boundedJson(value: unknown, limit: number): string {
  let encoded: string;
  try {
    const result = JSON.stringify(value);
    encoded = result === undefined ? String(value) : result;
  } catch {
    encoded = "[unserializable input]";
  }
  if (encoded.length <= limit) return encoded;
  return `${encoded.slice(0, Math.max(0, limit - 27))}...[truncated input]`;
}

function assertOperationalStage(stage: string): void {
  if (!operationalStages.has(stage)) {
    reject(`current stage ${JSON.stringify(stage)} is not an operational setup stage`);
  }
}

function assertCheckBudget(step: SetupStep, task: TaskContext): void {
  const checks = new Set([...requiredStageChecks(step.stage, task), ...step.checks]);
  if (checks.size > 128) {
    reject(`step ${JSON.stringify(step.id)} has more than 128 distinct checks`);
  }
}

function assertActiveChecksRetained(previous: SetupStep, proposed: SetupStep): void {
  const proposedCounts = new Map<string, number>();
  for (const check of proposed.checks) {
    proposedCounts.set(check, (proposedCounts.get(check) ?? 0) + 1);
  }
  for (const check of previous.checks) {
    const count = proposedCounts.get(check) ?? 0;
    if (count === 0) {
      reject(`active step must retain check ${JSON.stringify(check)}`);
    }
    proposedCounts.set(check, count - 1);
  }
}

export function validateSetupProposal(
  previous: TaskContext,
  proposed: SetupPlan,
  stage: string,
  activeStepId: string | null,
  recovery: boolean,
): void {
  if (previous.deliveryStages !== undefined) {
    reject("legacy deliveryStages cannot be automated");
  }
  assertOperationalStage(stage);

  const parsed = setupPlanSchema.parse(proposed);
  for (const step of parsed.steps) assertCheckBudget(step, previous);

  if (!recovery) {
    if (parsed.steps[0]!.stage !== stage) {
      reject("the first setup step must match the current operational stage");
    }
    return;
  }

  if (previous.setup === undefined) {
    reject("recovery requires a previous setup");
  }
  if (activeStepId === null) {
    reject("recovery requires a valid active setup step ID");
  }

  const previousSetup = setupPlanSchema.parse(previous.setup);
  const previousIndex = previousSetup.steps.findIndex((step) => step.id === activeStepId);
  const proposedIndex = parsed.steps.findIndex((step) => step.id === activeStepId);
  if (previousIndex < 0 || proposedIndex < 0) {
    reject("recovery requires the active setup step ID in both plans");
  }
  if (previousIndex !== proposedIndex) {
    reject("recovery must keep the active setup step at the same position");
  }

  const previousActive = previousSetup.steps[previousIndex]!;
  const proposedActive = parsed.steps[proposedIndex]!;
  if (previousActive.stage !== stage || proposedActive.stage !== stage) {
    reject("recovery must keep the active setup step in the current stage");
  }
  if (!isDeepStrictEqual(
    previousSetup.steps.slice(0, previousIndex),
    parsed.steps.slice(0, proposedIndex),
  )) {
    reject("completed setup steps must remain structurally identical during recovery");
  }
  assertActiveChecksRetained(previousActive, proposedActive);
}

type SetupPromptInput = {
  task: TaskContext;
  stage: string;
  activeStepId: string | null;
  recoveryReason: string | null;
  catalog: unknown;
  playbooks: unknown;
};

export function buildSetupPrompt(input: SetupPromptInput): string {
  const dynamic = [
    `Current operational stage: ${boundedJson(input.stage, 128)}`,
    `Active setup step ID: ${boundedJson(input.activeStepId, 128)}`,
    `Recovery reason: ${boundedJson(input.recoveryReason, MAX_RECOVERY_REASON)}`,
    `Saved task context:\n${boundedJson(input.task, MAX_TASK_TEXT)}`,
    `Live provider/model/skill catalog:\n${boundedJson(input.catalog, MAX_CATALOG_TEXT)}`,
    `Checked setup playbooks:\n${boundedJson(input.playbooks, MAX_PLAYBOOK_TEXT)}`,
  ].join("\n\n");
  const prompt = `${SETUP_WORKER_INSTRUCTIONS}\n\n${dynamic}`;
  return prompt.length <= MAX_PROMPT_LENGTH
    ? prompt
    : `${prompt.slice(0, MAX_PROMPT_LENGTH - 27)}...[truncated prompt]`;
}
