import { createHash } from "node:crypto";
import { PLUGIN_ID } from "./plugin-id";
import type { SetupPlan, SetupStep } from "./setup-plan";

export const TASK_KINDS = ["feature", "bug-fix", "refactor", "perf"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
type KindTask = { kind?: TaskKind; deliveryTarget?: "pr" | "local" };
type TemplateStep = Pick<SetupStep, "id" | "stage" | "title" | "instructions" | "checks"> & { skills: string[] };

// bb's catalog ID for a skill in this plugin's skills/ folder. Names would
// collide with provider copies of the same skill.
export const skillId = (name: string, pluginId = PLUGIN_ID) =>
  `skill_${createHash("sha256").update(`bb-plugin:${pluginId}\0${name}/SKILL.md`).digest("hex")}`;

const quality: TemplateStep = {
  id: "quality", stage: "quality", title: "Strict review of the task diff",
  instructions: "Review the full task diff against the Saved Task and fix valid findings within scope.",
  checks: ["Strict review reports no findings."],
  skills: ["thermo-nuclear-code-quality-review", "principle-minimize-reader-load"],
};
const bugHunt: TemplateStep = {
  id: "bug-hunt", stage: "quality", title: "Hunt failure paths in the diff",
  instructions: "Follow the Diff branch of /bug-hunt on the task diff and fix every finding within scope.",
  checks: ["Each external call and stored state in the diff has a test or an accepted-risk line for every failure question."],
  skills: ["bug-hunt"],
};
const simplify: TemplateStep = {
  id: "simplify", stage: "simplify", title: "Simplify the task changes",
  instructions: "Reduce needless code in the task diff without changing behavior.",
  checks: ["Behavior does not change and all required checks pass."],
  skills: ["simplify", "ponytail"],
};
const pr: TemplateStep = {
  id: "pr", stage: "pr", title: "PR Watch",
  instructions: "Open or reuse the pull request and watch it until it is ready to merge.",
  checks: [],
  skills: ["babysit-pr", "show-me", "pr-proof"],
};
const diagnose = ["diagnosing-bugs", "principle-fix-root-causes"];
const liveCall = "Each external API the change calls answered one real request (sandbox, dev, or local stack), and the test fixture comes from that reply; or the PR's Not verified list names it with the post-merge check.";

const templates: Record<TaskKind, TemplateStep[]> = {
  feature: [{
    id: "build", stage: "tdd", title: "Build the change",
    instructions: "Build the change test-first through the accepted test interfaces, then run it on the surface it touches.",
    checks: ["The change works on the surface it touches, shown by a run, not unit tests alone.", liveCall],
    skills: ["tdd", "ponytail", "principle-model-the-domain", "principle-test-behavior-not-implementation"],
  }, quality, bugHunt, simplify],
  "bug-fix": [{
    id: "reproduce", stage: "tdd", title: "Reproduce the defect",
    instructions: "Reproduce the reported defect and capture its failing output before any fix.",
    checks: ["Failing output from the reported defect, captured before any fix."],
    skills: diagnose,
  }, {
    id: "root-cause", stage: "tdd", title: "Find the root cause",
    instructions: "Find how the defect occurs and confirm it with evidence from a run.",
    checks: ["Evidence from a run confirms how the defect occurs."],
    skills: diagnose,
  }, {
    id: "fix", stage: "tdd", title: "Fix the defect",
    instructions: "Commit a failing test for the reproduction, then fix the root cause in a later commit.",
    checks: ["The same reproduction now passes and the failing test commit comes before the fix commit.", liveCall],
    skills: ["tdd", "ponytail", "principle-test-behavior-not-implementation"],
  }, quality, bugHunt, simplify],
  refactor: [{
    id: "pin-behavior", stage: "tdd", title: "Pin current behavior",
    instructions: "Record current behavior before code moves. Prove each pin test can fail by changing the code on purpose.",
    checks: ["A characterization test or equivalence check records current behavior before code moves."],
    skills: ["tdd", "principle-test-behavior-not-implementation"],
  }, {
    id: "subtract", stage: "tdd", title: "Remove dead code",
    instructions: "Remove dead code and one-caller wrappers while the pin stays green.",
    checks: ["Dead code and one-caller wrappers are removed and the pin stays green."],
    skills: ["ponytail", "principle-subtract-before-you-add", "principle-migrate-callers-then-delete-legacy-apis"],
  }, {
    id: "reshape", stage: "tdd", title: "Reshape the code",
    instructions: "Move callers to the new shape and delete the old API in the same step.",
    checks: ["Callers use the new shape, the old API is deleted in the same step, the pin stays green."],
    skills: ["tdd", "codebase-design", "principle-model-the-domain", "principle-sequence-verifiable-units"],
  }, quality],
  perf: [{
    id: "baseline", stage: "tdd", title: "Measure the baseline",
    instructions: "Capture a baseline number from a named probe before any change.",
    checks: ["A baseline number from a named probe, captured before any change."],
    skills: ["benchmark-checklist"],
  }, {
    id: "fix", stage: "tdd", title: "Make the change",
    instructions: "Make the performance change while existing tests stay green.",
    checks: ["Existing tests stay green."],
    skills: ["tdd", "ponytail", "principle-sequence-verifiable-units"],
  }, {
    id: "measure", stage: "tdd", title: "Measure the result",
    instructions: "Run the same probe again and report the change from the baseline.",
    checks: ["An after number from the same probe with the change from the baseline."],
    skills: ["benchmark-checklist"],
  }, quality],
};

/** Template steps with skill names: each kind's own steps, then PR Watch for a PR target. */
export function kindSteps(kind: TaskKind, deliveryTarget?: KindTask["deliveryTarget"]): TemplateStep[] {
  return deliveryTarget === "pr" ? [...templates[kind], pr] : templates[kind];
}

/** Template Setup Steps for a task's kind, in order, with skill catalog IDs; none without a kind. */
export function kindTemplate(task: KindTask): TemplateStep[] {
  if (!task.kind) return [];
  return kindSteps(task.kind, task.deliveryTarget).map(step => ({ ...step, checks: [...step.checks], skills: step.skills.map(name => skillId(name)) }));
}

/**
 * Reject a Task Setup that leaves out a template step without a skip reason,
 * or changes a template step's stage, checks, required skills or order.
 * Extra steps, checks and skills are allowed. A revision cannot add a step at
 * or before the active step, change a completed step, or change a started
 * step's skills, so a plan saved under an older template keeps those as they are.
 */
export function validateKindSteps(task: KindTask, plan: SetupPlan, active = -1, started = false): void {
  const template = kindTemplate(task);
  const skipped = new Set(plan.skipped?.map(skip => skip.stepId));
  for (const stepId of skipped) {
    if (!template.some(step => step.id === stepId)) throw new Error(`Skipped step ${JSON.stringify(stepId)} is not a ${task.kind ?? "task kind"} template step.`);
  }
  const indexes = template.map(expected => plan.steps.findIndex(step => step.id === expected.id));
  const placed = indexes.reduce((last, index, t) => index >= 0 && index <= active ? t : last, -1);
  let last = -1;
  for (const [t, expected] of template.entries()) {
    const index = indexes[t]!;
    if (index < 0) {
      if (skipped.has(expected.id) || t < placed) continue;
      throw new Error(`Keep template step ${JSON.stringify(expected.id)} or add it to skipped with a reason.`);
    }
    const step = plan.steps[index]!;
    if (step.stage !== expected.stage) throw new Error(`Template step ${JSON.stringify(step.id)} must keep stage ${expected.stage}.`);
    const check = index >= active && expected.checks.find(check => !step.checks.includes(check));
    if (check) throw new Error(`Template step ${JSON.stringify(step.id)} must keep check ${JSON.stringify(check)}.`);
    const skill = index >= active + Number(started) && expected.skills.find(skill => !step.execution.skills.includes(skill));
    if (skill) throw new Error(`Template step ${JSON.stringify(step.id)} must keep required skill ${skill}.`);
    if (index < last) throw new Error(`Keep template steps in template order; ${JSON.stringify(step.id)} is out of order.`);
    last = index;
  }
}
