import { z } from "zod";

const stages = ["tdd", "quality", "simplify", "pr"] as const;
const checkStages = ["design", "tdd", "quality", "simplify"] as const;
const checkNames = z.array(z.string().trim().min(1).max(256)).max(128);

export const deliveryStagesSchema = z.array(z.enum(stages)).min(1).max(4)
  .refine(plan => plan.every((stage, index) => index === 0 || stages.indexOf(stage) > stages.indexOf(plan[index - 1]!)),
    "Delivery stages must be unique and in workflow order.")
  .refine(plan => !plan.includes("tdd") || plan.includes("quality"),
    "TDD needs a Quality stage before delivery.");

export const stageChecksSchema = z.object({
  design: checkNames.optional(), tdd: checkNames.optional(),
  quality: checkNames.optional(), simplify: checkNames.optional(),
}).strict();

type TaskPlan = {
  requiredChecks: string[];
  deliveryStages?: z.infer<typeof deliveryStagesSchema>;
  stageChecks?: z.infer<typeof stageChecksSchema>;
};

export function nextDeliveryStage(stage: string, task: TaskPlan | null) {
  const plan = task?.deliveryStages ?? stages;
  if (stage === "design") return plan[0] ?? null;
  const index = plan.findIndex(item => item === stage);
  return index < 0 ? null : plan[index + 1] ?? null;
}

export function requiredStageChecks(stage: string, task: TaskPlan | null): string[] {
  const local = checkStages.includes(stage as typeof checkStages[number])
    ? task?.stageChecks?.[stage as typeof checkStages[number]] ?? [] : [];
  return [...new Set([...(task?.requiredChecks ?? []), ...local])];
}
