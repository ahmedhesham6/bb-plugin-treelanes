import { z } from "zod";
import { checkNameSchema } from "./delivery-plan";
import { stepExecutionSchema } from "./step-execution";

const stepIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const setupStepSchema = z.object({
  id: stepIdSchema,
  title: z.string().trim().min(1).max(160),
  stage: z.enum(["tdd", "quality", "simplify", "pr"]),
  instructions: z.string().trim().min(1).max(4096),
  checks: z.array(checkNameSchema).max(64),
  execution: stepExecutionSchema,
}).strict();

export const setupPlanSchema = z.object({
  summary: z.string().trim().min(1).max(1024),
  steps: z.array(setupStepSchema).min(1).max(24),
  // Kind template steps left out on purpose, each with its reason.
  skipped: z.array(z.object({ stepId: stepIdSchema, reason: z.string().trim().min(1).max(1024) }).strict()).max(24).optional(),
}).strict().superRefine((plan, ctx) => {
  const ids = [...plan.steps.map(step => step.id), ...(plan.skipped ?? []).map(skip => skip.stepId)];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "Setup step IDs must be unique, and a skipped step cannot also be a step." });
  }
  if (plan.steps.some((step, index) => step.stage === "pr" && index !== plan.steps.length - 1)) {
    ctx.addIssue({ code: "custom", message: "PR Watch must be the final setup step." });
  }
  if (plan.steps.some(step => step.stage !== "pr" && step.checks.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Each implementation step needs a clear check." });
  }
});

export type SetupPlan = z.infer<typeof setupPlanSchema>;
export type SetupStep = z.infer<typeof setupStepSchema>;

export function activeSetupStep(plan: SetupPlan | undefined, id: string | null | undefined) {
  return plan?.steps.find(step => step.id === id) ?? null;
}

export function nextSetupStep(plan: SetupPlan, id: string | null | undefined) {
  if (!id) return plan.steps[0] ?? null;
  const index = plan.steps.findIndex(step => step.id === id);
  if (index < 0) throw new Error("The active setup step is missing from the plan.");
  return plan.steps[index + 1] ?? null;
}

export function validateSetupRevision(previous: SetupPlan | undefined, next: SetupPlan | undefined, id: string | null | undefined, stage: string, started: boolean) {
  if (id) {
    const oldIndex = previous?.steps.findIndex(step => step.id === id) ?? -1;
    const newIndex = next?.steps.findIndex(step => step.id === id) ?? -1;
    if (oldIndex < 0 || newIndex !== oldIndex || next?.steps[newIndex]?.stage !== stage) {
      throw new Error("Keep the completed steps and current setup step when revising remaining work.");
    }
    if (JSON.stringify(previous!.steps.slice(0, oldIndex)) !== JSON.stringify(next!.steps.slice(0, newIndex))) {
      throw new Error("Completed setup steps are immutable. Revise only current and remaining work.");
    }
    if (started && JSON.stringify(previous!.steps[oldIndex]!.execution) !== JSON.stringify(next!.steps[newIndex]!.execution)) {
      throw new Error("This step has already started. Add a later step to change its execution setup.");
    }
  } else if (next && stage !== "design" && next.steps[0]!.stage !== stage) {
    throw new Error("The first setup step must match the current stage.");
  }
}


// Completed records are history. Keep the saved records when a caller
// abbreviates them while editing future work; IDs, stages and order stay strict.
export function preserveCompletedSteps(previous: SetupPlan | undefined, next: SetupPlan | undefined, activeId: string | null | undefined): SetupPlan | undefined {
  if (!previous || !next || !activeId) return next;
  const index = previous.steps.findIndex(step => step.id === activeId);
  if (index < 0 || next.steps[index]?.id !== activeId || previous.steps.slice(0, index).some((step, i) =>
    step.id !== next.steps[i]?.id || step.stage !== next.steps[i]?.stage)) return next;
  return { ...next, steps: [...previous.steps.slice(0, index), ...next.steps.slice(index)] };
}

export function requirePrWatch(task: { deliveryTarget?: "pr" | "local"; setup?: SetupPlan; deliveryStages?: readonly string[] }) {
  if (task.deliveryTarget !== "pr") return;
  const finalStage = task.setup?.steps.at(-1)?.stage ?? task.deliveryStages?.at(-1);
  if ((task.setup || task.deliveryStages) && finalStage !== "pr") throw new Error("Keep PR Watch as the final step. You may change the work before it.");
}

// A matching legacy stage list adds no authority beyond the setup.
export function normalizeLegacyDeliveryStages(task: { setup?: SetupPlan; deliveryStages?: readonly string[] }): void {
  if (!task.setup || !task.deliveryStages) return;
  const stages = task.setup.steps.map(step => step.stage)
    .filter((stage, index, all) => index === 0 || stage !== all[index - 1]);
  if (JSON.stringify(stages) !== JSON.stringify(task.deliveryStages)) {
    throw new Error("deliveryStages conflicts with setup. Keep setup and omit deliveryStages, or make the stage order match.");
  }
  delete task.deliveryStages;
}
