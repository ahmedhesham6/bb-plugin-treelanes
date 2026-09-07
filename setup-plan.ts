import { z } from "zod";
import { stepExecutionSchema } from "./step-execution";

export const setupStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: z.string().trim().min(1).max(160),
  stage: z.enum(["tdd", "quality", "simplify", "pr"]),
  instructions: z.string().trim().min(1).max(4096),
  checks: z.array(z.string().trim().min(1).max(256)).max(64),
  execution: stepExecutionSchema,
}).strict();

export const setupPlanSchema = z.object({
  summary: z.string().trim().min(1).max(1024),
  steps: z.array(setupStepSchema).min(1).max(24),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.steps.map(step => step.id)).size !== plan.steps.length) {
    ctx.addIssue({ code: "custom", message: "Setup step IDs must be unique." });
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
