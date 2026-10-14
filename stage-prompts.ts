import type { StageId } from "./workflow";

export const DELIVERY_SKILL_INSTRUCTION = "Use /delivery. Read its current files with `bb skill list` and `bb skill show <id> [--path <relative-file>]`; cached copies may be old.";

export const IMPLEMENTATION_GUIDE = "Use /ponytail with the stage skill (full unless changed or stopped). Read what this task needs; deliver the smallest correct change through its required checks.";

export const DEFAULT_STAGE_PROMPTS = {
  tdd: "Implement the saved step through the accepted test interfaces.",
  quality: "Review the task diff and fix valid findings within scope.",
  simplify: "Reduce needless code in the task diff and preserve behavior.",
  pr: "/babysit-pr Push the task PR and fixes. Monitor checks and comments; repeat until required checks are green and actionable threads are resolved. Leave merge to the user.",
} as const;

const STAGE_SKILLS: Partial<Record<StageId, string>> = {
  design: "/grilling", tdd: "the tdd skill", quality: "the thermo-nuclear-code-quality-review skill",
  simplify: "the simplify skill", pr: "/babysit-pr", review: "/code-review",
};
const OLD_PR_STOP_INSTRUCTION = "If a required check cannot pass, stop and report the blocker without opening a pull request.";
const TDD_STEP_INSTRUCTION = "TDD: Reuse coverage; add tests for distinct behavior or likely regressions. Wording-only or low-impact edits need existing checks, not new tests. Avoid prompt/skill string checks and snapshots. Review the full diff, including uncommitted work. If tests/fixtures exceed 50% of changed lines, trim low-value cases and explain retained coverage; keep real-risk tests. Run required checks. Add no report file.";

export function buildStagePrompt(input: {
  stage: StageId; prompt: string; environmentId: string;
  stageUpdatedAt?: number; taskRevision: number;
  activeStepId?: string | null; previousThreadId: string;
}): string {
  const { prompt, ...assignment } = input;
  const stagePrompt = (input.stage === "pr" ? prompt.replace(OLD_PR_STOP_INSTRUCTION, "") : prompt).trim();
  const skill = STAGE_SKILLS[input.stage];
  return [
    DELIVERY_SKILL_INSTRUCTION,
    skill && !stagePrompt.startsWith(`${skill} `) ? `Use ${skill}.` : "",
    stagePrompt,
    ["tdd", "quality", "simplify"].includes(input.stage) ? IMPLEMENTATION_GUIDE : "",
    input.stage === "tdd" ? TDD_STEP_INSTRUCTION : "",
    input.stage === "pr" ? "Before PR actions, read /delivery's references/pr-watch.md. For the PR description, use /visual-pr instead of /show-me or the older description-format guidance. Then continue /babysit-pr; publishing the description does not end PR Watch." : "",
    "Read treelanes_get_context. Follow the saved task and activeStep; load execution.selectedSkills and use the exact requiredChecks. Fresh context governs the work.",
    `Assignment: ${JSON.stringify(assignment)}`,
  ].filter(Boolean).join("\n");
}
