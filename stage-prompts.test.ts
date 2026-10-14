import { describe, expect, it } from "vitest";
import { buildStagePrompt, DEFAULT_STAGE_PROMPTS } from "./stage-prompts";

const assignment = { environmentId: "env-test", stageUpdatedAt: 42, taskRevision: 7,
  activeStepId: "work", previousThreadId: "previous" };

describe("stage handoffs", () => {
  it.each([
    ["tdd", "/tdd"], ["quality", "/thermo-nuclear-code-quality-review"],
    ["simplify", "/simplify"], ["pr", "/babysit-pr"],
  ] as const)("routes %s through its skill even with a custom prompt", (stage, skill) => {
    const prompt = buildStagePrompt({ ...assignment, stage, prompt: "Keep the accepted API." });
    expect(prompt).toContain("/delivery");
    expect(prompt).toContain(skill);
    expect(prompt).toContain("workflow_board_get_context");
    expect(prompt).toContain("execution.selectedSkills");
    expect(prompt).toContain("bb skill show");
    expect(prompt).toContain("Keep the accepted API.");
    expect(prompt).toContain('"previousThreadId":"previous"');
    expect(prompt).toContain('"taskRevision":7');
    expect(prompt.length).toBeLessThan(1200);
    expect(DEFAULT_STAGE_PROMPTS[stage].length).toBeLessThan(200);
  });

  it("routes PR details to the PR reference and removes the obsolete stop rule", () => {
    const prompt = buildStagePrompt({ ...assignment, stage: "pr",
      prompt: "Follow the repo rules. If a required check cannot pass, stop and report the blocker without opening a pull request." });
    expect(prompt).toContain("references/pr-watch.md");
    expect(prompt).toContain("Follow the repo rules.");
    expect(prompt).not.toContain("without opening a pull request");
    expect(prompt).not.toContain("gh pr create");
  });
});
