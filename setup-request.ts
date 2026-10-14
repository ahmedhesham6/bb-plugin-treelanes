import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { requiredStageChecks } from "./delivery-plan";
import { normalizeLegacyDeliveryStages, requirePrWatch, setupPlanSchema, type SetupPlan, type SetupStep } from "./setup-plan";
import type { TaskContext } from "./stage-evidence";
import { DELIVERY_SKILL_INSTRUCTION, IMPLEMENTATION_GUIDE } from "./stage-prompts";
import { kindTemplate, validateKindSteps } from "./task-kinds";

const operationalStages = new Set(["tdd", "quality", "simplify", "pr"]);
export const setupProposalSchema = z
  .object({ setup: setupPlanSchema })
  .strict();

function reject(message: string): never {
  throw new Error(`Setup proposal rejected: ${message}`);
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
  assertOperationalStage(stage);

  const parsed = setupPlanSchema.parse(proposed);
  normalizeLegacyDeliveryStages({ ...previous, setup: parsed });
  requirePrWatch({ ...previous, setup: parsed });
  validateKindSteps(previous, parsed);
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
  environmentId: string;
  requestId: number;
  taskRevision: number;
  stage: string;
  activeStepId: string | null;
  recoveryReason: string | null;
  task?: Pick<TaskContext, "kind" | "deliveryTarget">;
};

export function buildSetupPrompt(input: SetupPromptInput): string {
  const template = kindTemplate(input.task ?? {});
  return [
    DELIVERY_SKILL_INSTRUCTION,
    IMPLEMENTATION_GUIDE,
    "You are the persistent task orchestrator. Plan the complete saved outcome, with only needed steps and children. Read /delivery's references/orchestration.md.",
    "Read treelanes_get_context for the full saved task and treelanes_catalog for live execution choices. Follow its modelMap preferences and modelSelectionPolicy; explain alternatives in execution.modelOverrideReason. Submit treelanes_apply_setup, then end this turn. Do not edit product code.",
    `Assignment: ${JSON.stringify({ environmentId: input.environmentId, requestId: input.requestId,
      taskRevision: input.taskRevision, stage: input.stage, activeStepId: input.activeStepId,
      recoveryReason: input.recoveryReason?.slice(0, 2048) ?? null })}`,
    ...(template.length ? [`Task kind ${input.task!.kind}: copy these template steps in order with the same id, stage and checks, and put their skills in execution.skills. You may edit title and instructions and add steps, checks and skills. Template: ${JSON.stringify(template)}`] : []),
  ].join("\n");
}
