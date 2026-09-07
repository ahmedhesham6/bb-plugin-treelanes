import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { makeWorkspaceSdk } from "./test-workspace";
import type { ProviderInfo } from "@get-bb/plugin-sdk";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

async function setup() {
  const snapshot = makeWorkspaceSdk({ files: { "src/file.ts": { content: "new" } } });
  const root = {
    ...makeThreadResponse({ id: "root", projectId: "project", parentThreadId: null, status: "idle" }),
    environmentId: "env", environmentName: "test", environmentBranchName: "feat/test",
    environmentWorkspaceDisplayKind: "managed-worktree" as const,
  };
  const threads = [root];
  const visibility = { hideWorkers: false, failNextSpawnAfterCreate: false };
  const requests: Array<{ prompt?: string; providerId?: string; model?: string; reasoningLevel?: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "workflow-board",
    sdk: {
      providers: {
        list: async () => [],
        models: async () => ({ modelLoadError: null, permissionCeiling: "auto", providers: ["codex", "claude-code"].map(id => ({ id, available: true } as ProviderInfo)), selectedOnlyModels: [],
          models: ["small", "large"].map(model => ({ id: model, model, displayName: model, description: "Test model", isDefault: false,
            defaultReasoningEffort: "low" as const, supportedReasoningEfforts: [{ reasoningEffort: "low" as const, description: "Low" }, { reasoningEffort: "high" as const, description: "High" }] })) }),
      },
      skills: { list: async () => ({ skills: [{ id: "test-skill", name: "tdd", filePath: "/skills/tdd/SKILL.md", description: "Test first", manageable: false, pluginId: null, provider: null, registrySkillId: null, scope: "bb-user" }] }) },
      threads: {
        get: async ({ threadId }) => threads.find(t => t.id === threadId)!,
        list: async () => visibility.hideWorkers ? [root] : threads,
        interactions: { list: async () => [] }, queuedMessages: { list: async () => [] },
        defaultExecutionOptions: async () => ({ model: "gpt-5.6-sol", reasoningLevel: "high", permissionMode: "auto", source: "client/turn/start" }),
        spawn: async (request) => {
          requests.push(request);
          const worker = { ...root, providerId: request.providerId ?? root.providerId, id: `worker-${requests.length}`, title: request.title ?? "worker", parentThreadId: root.id };
          threads.push(worker);
          if (visibility.failNextSpawnAfterCreate) { visibility.failNextSpawnAfterCreate = false; throw new Error("Spawn transport response lost"); }
          return worker;
        },
      },
      files: snapshot.sdk.files,
      environments: { ...snapshot.sdk.environments, get: async () => ({
        id: "env", name: "test", projectId: "project", hostId: "remote-host", path: "/srv/worktree", managed: true,
        isGitRepo: true, isWorktree: true, workspaceProvisionType: "managed-worktree", branchName: "feat/test",
        baseBranch: "main", mergeBaseBranch: "main", defaultBranch: "main", status: "ready", createdAt: 1, updatedAt: 2,
      }) },
      projects: { list: async () => [{ id: "project", name: "Project" }] },
    },
  });
  disposals.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const agent = { threadId: root.id, projectId: "project" };
  await harness.behavior.callAgentTool("workflow_board_move_card", { stage: "tdd" }, agent);
  const task = { outcome: "Fix the reported bug", scope: ["src/api.ts"], decisions: ["Keep the existing API"],
    requiredChecks: ["API regression"], allowedActions: ["Edit and test"], confirmations: ["User requested fix in root"], testInterfaces: ["public API"] };
  await harness.behavior.callAgentTool("workflow_board_set_task", task, agent);
  const context = async () => JSON.parse(await harness.behavior.callAgentTool("workflow_board_get_context", {}, agent) as string);
  const receipt = async () => {
    const ctx = await context();
    return { stage: "tdd", stageUpdatedAt: ctx.stageUpdatedAt, taskRevision: ctx.taskRevision, workspaceDigest: ctx.workspaceDigest,
      checks: [{ name: "API regression", status: "passed", evidence: "npm test -- api: 3 tests passed" }],
      decisionsResolved: true, openFindings: [], summary: "API regression fixed and tested." };
  };
  const submit = (value: unknown) => harness.behavior.callAgentTool("workflow_board_complete_stage", value, agent);
  const idle = (thread = root) => harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Verified.\n[workflow:tdd-complete]" });
  const stage = () => (bb.storage.database().prepare("SELECT stage FROM worktree_cards WHERE environment_id = 'env'").get() as { stage: string }).stage;
  return { snapshot, bb, harness, root, threads, visibility, requests, agent, task, context, receipt, submit, idle, stage };
}

describe("saved stage evidence", () => {
  it("automatically plans, validates, and starts an authorized task once across reload", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_deliver", { stage: "tdd", task: t.task }, t.agent);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.prompt).toContain("workflow_board_apply_setup");
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    const proposal = { setup: { summary: "One focused fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix the API bug", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: ["tdd"], reason: "Bounded API change" } }] } };
    await t.harness.behavior.callAgentTool("workflow_board_apply_setup", proposal, planner);
    expect(t.requests).toHaveLength(1);
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]).toMatchObject({ providerId: "codex", model: "small", reasoningLevel: "low" });
    const worker = { ...t.agent, threadId: t.threads[2]!.id };
    const context = JSON.parse(await t.harness.behavior.callAgentTool("workflow_board_get_context", {}, worker) as string);
    expect(context.ownerThreadId).toBe(worker.threadId);
    expect(context.activeStep.id).toBe("fix");
  });

  it("replans failed workers twice, retains checks, and then stops", async () => {
    const t = await setup();
    const proposal = { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } };
    await t.harness.behavior.callAgentTool("workflow_board_deliver", { stage: "tdd", task: t.task }, t.agent);
    await expect(t.harness.behavior.callAgentTool("workflow_board_apply_setup", proposal, t.agent)).rejects.toThrow(/assigned/);
    for (let cycle = 0; cycle < 3; cycle++) {
      const planner = { ...t.agent, threadId: t.threads.at(-1)!.id };
      if (cycle > 0) {
        const dropped = structuredClone(proposal); dropped.setup.steps[0]!.checks = ["easier"];
        await expect(t.harness.behavior.callAgentTool("workflow_board_apply_setup", dropped, planner)).rejects.toThrow(/retain/);
        proposal.setup.steps[0]!.execution.model = "large";
        proposal.setup.steps[0]!.execution.reasoningLevel = "high";
        proposal.setup.steps[0]!.instructions = `Address failure ${cycle}`;
      }
      await t.harness.behavior.callAgentTool("workflow_board_apply_setup", proposal, planner);
      await t.harness.behavior.runSchedule("reconcile-worktrees");
      const worker = t.threads.at(-1)!;
      expect(worker.id).not.toBe(planner.threadId);
      worker.status = "error";
      await t.harness.behavior.runSchedule("reconcile-worktrees");
    }
    expect(t.requests).toHaveLength(6);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(6);
    expect(t.requests[3]?.model).toBe("large");
    const current = await t.context();
    expect(current.task.requiredChecks).toEqual(t.task.requiredChecks);
    expect(current.task.allowedActions).toEqual(t.task.allowedActions);
  });

  it("waits for the worker to stop and respects pause before plan recovery", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_deliver", { stage: "tdd", task: t.task }, t.agent);
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    await t.harness.behavior.callAgentTool("workflow_board_apply_setup", { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } }, planner);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = t.threads[2]!; worker.status = "active";
    await t.harness.behavior.callAgentTool("workflow_board_recover", { reason: "The regression still fails after local fixes" }, { ...t.agent, threadId: worker.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees"); expect(t.requests).toHaveLength(2);
    worker.status = "idle";
    await t.harness.behavior.runCli(["pause", "env"]);
    await t.harness.behavior.runSchedule("reconcile-worktrees"); expect(t.requests).toHaveLength(2);
    await t.harness.behavior.runCli(["resume", "env"]); expect(t.requests).toHaveLength(3);
  });

  it("adopts a live setup worker after a lost spawn response and reload", async () => {
    const t = await setup(); t.visibility.failNextSpawnAfterCreate = true;
    await t.harness.behavior.callAgentTool("workflow_board_deliver", { stage: "tdd", task: t.task }, t.agent);
    t.threads[1]!.status = "active";
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(1);
    const context = JSON.parse(await t.harness.behavior.callAgentTool("workflow_board_get_context", {}, t.agent) as string);
    expect(context.automaticSetup).toMatchObject({ status: "started", thread_id: t.threads[1]!.id, attempts: 1 });
    const health = await t.harness.behavior.runCli(["health", "project"]);
    expect(JSON.parse(String(health.stdout))).toEqual([]);
  });

  it("keeps a paused proposal and an unsupported model from changing the task", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_deliver", { stage: "tdd", task: t.task }, t.agent);
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    const proposal = { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "missing", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } };
    const before = await t.context();
    await expect(t.harness.behavior.callAgentTool("workflow_board_apply_setup", proposal, planner)).rejects.toThrow(/model/i);
    proposal.setup.steps[0]!.execution.model = "small";
    await t.harness.behavior.runCli(["pause", "env"]);
    await expect(t.harness.behavior.callAgentTool("workflow_board_apply_setup", proposal, planner)).rejects.toThrow(/unpaused/);
    expect((await t.context()).taskRevision).toBe(before.taskRevision);
    expect(t.requests).toHaveLength(1);
    await expect(t.harness.behavior.callAgentTool("workflow_board_set_task", t.task, planner)).rejects.toThrow(/cannot change/);
  });

  it("does not replan a worker error while human input is pending", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("workflow_board_apply_setup", { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } }, { ...t.agent, threadId: t.threads[1]!.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    Object.assign(t.threads[2]!, { status: "error", hasPendingInteraction: true });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
  });

  it("runs custom steps with chosen execution and resumes the next step after reload", async () => {
    const t = await setup();
    const step = (id: string, model: string, reasoningLevel: string) => ({ id, title: id, stage: "tdd", instructions: `Do ${id} only`, checks: ["Step check"],
      execution: { providerId: "codex", model, reasoningLevel, skills: ["tdd"], reason: "Fits this step" } });
    const task = { ...t.task, setup: { summary: "Inspect then implement", steps: [step("inspect", "small", "low"), step("implement", "large", "high")] } };
    task.setup.steps[1]!.execution.providerId = "claude-code";
    await t.harness.behavior.callAgentTool("workflow_board_set_task", task, t.agent);
    await t.harness.behavior.callAgentTool("workflow_board_start", {}, t.agent);
    expect(t.requests[0]).toMatchObject({ providerId: "codex", model: "small", reasoningLevel: "low" });
    expect(t.requests[0]?.prompt).toContain("/skills/tdd/SKILL.md");
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("workflow_board_get_context", {}, worker) as string);
    expect(ctx.activeStep.id).toBe("inspect");
    await t.harness.behavior.callAgentTool("workflow_board_complete_stage", { ...await t.receipt(), stageUpdatedAt: ctx.stageUpdatedAt,
      checks: [{ name: "API regression", status: "passed", evidence: "3 tests pass" }, { name: "Step check", status: "passed", evidence: "Inspection passed" }] }, worker);
    const reloaded = await t.harness.lifecycle.reload(plugin);
    t.harness = reloaded.harness;
    disposals.push(() => reloaded.harness.lifecycle.dispose());
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]).toMatchObject({ providerId: "claude-code", model: "large", reasoningLevel: "high" });
    const nextWorker = { ...t.agent, threadId: t.threads[2]!.id };
    const next = JSON.parse(await t.harness.behavior.callAgentTool("workflow_board_get_context", {}, nextWorker) as string);
    expect(next.activeStep.id).toBe("implement");
    expect(next.completedStepIds).toEqual(["inspect"]);
    expect(next.stageUpdatedAt).toBeGreaterThan(ctx.stageUpdatedAt);
    await t.harness.behavior.callAgentTool("workflow_board_complete_stage", { stage: next.stage, stageUpdatedAt: next.stageUpdatedAt,
      taskRevision: next.taskRevision, workspaceDigest: next.workspaceDigest, decisionsResolved: true, openFindings: [], summary: "Implementation passed",
      checks: [{ name: "API regression", status: "passed", evidence: "3 tests pass" }, { name: "Step check", status: "passed", evidence: "Implementation passed" }] }, nextWorker);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    const playbooks = await t.harness.behavior.runCli(["playbooks", "project"]);
    expect(JSON.parse(String(playbooks.stdout))).toHaveLength(1);
    expect(JSON.parse(String(playbooks.stdout))[0].setup.steps).toHaveLength(2);
  });

  it("adds and removes future steps but freezes a started step's execution", async () => {
    const t = await setup();
    const step = (id: string) => ({ id, title: id, stage: "tdd", instructions: `Run ${id}`, checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: ["tdd"], reason: "Focused work" } });
    const task = { ...t.task, setup: { summary: "One checked step", steps: [step("fix")] } };
    await t.harness.behavior.callAgentTool("workflow_board_set_task", task, t.agent);
    await t.harness.behavior.callAgentTool("workflow_board_start", {}, t.agent);
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const added = { ...task, setup: { summary: "Add a check after new findings", steps: [...task.setup.steps, step("check")] } };
    await t.harness.behavior.callAgentTool("workflow_board_set_task", added, worker);
    expect((await t.context()).nextStep.id).toBe("check");
    await t.harness.behavior.callAgentTool("workflow_board_set_task", task, worker);
    expect((await t.context()).nextStep).toBeNull();
    const changed = structuredClone(task); changed.setup.steps[0]!.execution.model = "large";
    await expect(t.harness.behavior.callAgentTool("workflow_board_set_task", changed, worker)).rejects.toThrow(/already started/);
    expect(t.requests).toHaveLength(1);
  });

  it("blocks setup dispatch while paused and never substitutes an unknown model", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, setup: { summary: "Check selection", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix the bug", checks: ["API regression"],
      execution: { providerId: "codex", model: "missing", reasoningLevel: "low", skills: [], reason: "Explicit choice" },
    }] } }, t.agent);
    await t.harness.behavior.runCli(["pause", "env"]);
    await expect(t.harness.behavior.callAgentTool("workflow_board_start", {}, t.agent)).rejects.toThrow(/paused/);
    await t.harness.behavior.runCli(["resume", "env"]);
    await expect(t.harness.behavior.callAgentTool("workflow_board_start", {}, t.agent)).rejects.toThrow(/model/i);
    expect(t.requests).toHaveLength(0);
    const corrected = (await t.context()).task;
    corrected.setup.steps[0].execution.model = "small";
    await t.harness.behavior.callAgentTool("workflow_board_set_task", corrected, t.agent);
    await t.harness.behavior.callAgentTool("workflow_board_start", {}, t.agent);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.model).toBe("small");
  });

  it("stores a PR setup only after a matching merge", async () => {
    const t = await setup();
    const execution = { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded work" };
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, setup: { summary: "Fix and PR", steps: [
      { id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"], execution },
      { id: "pr", title: "PR", stage: "pr", instructions: "Create and watch PR", checks: [], execution },
    ] } }, t.agent);
    t.harness.inspection.sdk.stub("environments.pullRequest", async () => ({ outcome: "available", pullRequest: {
      attention: "merged", baseRefName: "main", headRefName: "feat/test", state: "merged", number: 7,
      title: "Fix", updatedAt: "2026-09-05T00:00:00Z", url: "https://github.com/example/repo/pull/7",
      checks: { failedCount: 0, passedCount: 1, pendingCount: 0, state: "passing", totalCount: 1 },
      mergeability: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", state: "mergeable" },
      review: { reviewRequestCount: 0, state: "approved" },
    } }));
    await expect(t.harness.behavior.callAgentTool("workflow_board_move_card", { stage: "done" }, t.agent)).rejects.toThrow(/setup.*complete/i);
    await t.submit(await t.receipt()); await t.idle();
    expect(t.stage()).toBe("pr");
    const before = await t.harness.behavior.runCli(["playbooks", "project"]);
    expect(JSON.parse(String(before.stdout))).toEqual([]);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.stage()).toBe("done");
    const after = await t.harness.behavior.runCli(["playbooks", "project"]);
    expect(JSON.parse(String(after.stdout))).toEqual([expect.objectContaining({ pullRequest: expect.objectContaining({ number: 7 }), results: [expect.objectContaining({ stepId: "fix" })] })]);
  });

  it("ignores normal idle text outside a worktree without recording an error", async () => {
    const t = await setup();
    t.harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "plain" }));
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "plain" }), lastAssistantText: "Read-only evaluation complete." });
    expect(t.harness.inspection.logEntries.filter(entry => entry.level === "error")).toEqual([]);
  });

  it("requires fresh evidence after the delivery plan changes", async () => {
    const t = await setup(); await t.submit(await t.receipt());
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, deliveryStages: ["tdd", "quality", "pr"] }, t.agent);
    await t.idle(); expect(t.stage()).toBe("tdd"); expect(t.requests).toHaveLength(0);
  });

  it("uses the task plan to skip a needless Simplify stage", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, deliveryStages: ["tdd", "quality", "pr"] }, t.agent);
    await t.submit(await t.receipt()); await t.idle();
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("workflow_board_get_context", {}, worker) as string);
    expect(ctx.nextStage).toBe("pr");
    await t.harness.behavior.callAgentTool("workflow_board_complete_stage", { ...await t.receipt(), stage: "quality", stageUpdatedAt: ctx.stageUpdatedAt, workspaceDigest: ctx.workspaceDigest }, worker);
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: t.threads[1]!, lastAssistantText: "Clear.\n[workflow:quality-clear]" });
    expect(t.stage()).toBe("pr");
    expect(t.requests).toHaveLength(2);
  });

  it("keeps global checks and adds checks for the current stage", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, stageChecks: { tdd: ["Type check"], quality: ["Review"] } }, t.agent);
    expect((await t.context()).requiredChecks).toEqual(["API regression", "Type check"]);
    await expect(t.submit(await t.receipt())).rejects.toThrow(/Type check/);
    const receipt = await t.receipt(); receipt.checks.push({ name: "Type check", status: "passed", evidence: "tsc: exit 0" });
    await t.submit(receipt); await t.idle(); expect(t.stage()).toBe("quality");
  });

  it("can finish the planned work without starting PR work", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, deliveryStages: ["tdd", "quality"] }, t.agent);
    await t.submit(await t.receipt()); await t.idle();
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("workflow_board_get_context", {}, worker) as string);
    expect(ctx.nextStage).toBeNull();
    await t.harness.behavior.callAgentTool("workflow_board_complete_stage", { ...await t.receipt(), stage: "quality", stageUpdatedAt: ctx.stageUpdatedAt, workspaceDigest: ctx.workspaceDigest }, worker);
    await t.harness.behavior.runCli(["reconcile"]);
    expect(t.stage()).toBe("quality"); expect(t.requests).toHaveLength(1);
  });

  it.each([["tdd", "pr"], ["quality", "tdd"], ["quality", "quality"], ["review"]])("rejects an invalid delivery plan %j", async (...deliveryStages) => {
    const t = await setup();
    await expect(t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, deliveryStages }, t.agent)).rejects.toThrow();
  });

  it("reads the assigned worker even when it is hidden from the card", async () => {
    const t = await setup(); await t.submit(await t.receipt()); await t.idle();
    t.visibility.hideWorkers = true;
    const result = await t.harness.behavior.runCli(["health"]);
    expect(JSON.parse(String(result.stdout))).toEqual([expect.objectContaining({ status: "evidence-needed" })]);
  });

  it("does not let an agent bypass completion by assigning a later stage", async () => {
    const t = await setup();
    const result = await t.harness.behavior.callAgentTool("workflow_board_move_card", { stage: "pr" }, t.agent);
    expect(String(result)).toMatch(/completion receipt/i);
    expect(t.stage()).toBe("tdd");
    expect(t.requests).toHaveLength(0);
  });

  it("records check evidence and advances once with the same task and files", async () => {
    const t = await setup();
    const evidence = await t.receipt();
    await t.submit(evidence);
    const row = t.bb.storage.database().prepare("SELECT * FROM worktree_stage_results").get() as { task_revision: number; evidence_json: string };
    expect(row.task_revision).toBe(evidence.taskRevision);
    expect(JSON.parse(row.evidence_json)).toEqual(evidence);
    await Promise.all([t.idle(), t.idle()]);
    expect(t.stage()).toBe("quality");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.prompt).toContain("API regression");
    expect(t.requests[0]?.prompt).toContain("Keep the existing API");
    expect(t.requests[0]?.prompt).toContain('"previousThreadId":"root"');
  });

  it("requires evidence even when the assigned owner emits a completion marker", async () => {
    const t = await setup();
    await t.idle();
    expect(t.stage()).toBe("tdd");
    expect(t.requests).toHaveLength(0);
  });

  it("rejects a receipt for old files", async () => {
    const t = await setup(); const evidence = await t.receipt();
    t.snapshot.files.set("src/file.ts", { content: "changed" });
    await expect(t.submit(evidence)).rejects.toThrow(/stale/i);
    expect(t.stage()).toBe("tdd");
  });

  it("does not reuse a recorded receipt after files change", async () => {
    const t = await setup(); await t.submit(await t.receipt());
    t.snapshot.files.set("src/file.ts", { content: "changed" });
    await t.idle();
    expect(t.stage()).toBe("tdd"); expect(t.requests).toHaveLength(0);
  });

  it("does not reuse a receipt after the task revision changes", async () => {
    const t = await setup(); const evidence = await t.receipt(); await t.submit(evidence);
    await t.harness.behavior.callAgentTool("workflow_board_set_task", { ...t.task, scope: ["src/other.ts"] }, t.agent);
    expect((await t.context()).taskRevision).toBeGreaterThan(evidence.taskRevision);
    await t.idle();
    expect(t.stage()).toBe("tdd"); expect(t.requests).toHaveLength(0);
  });

  it("preserves the task revision when the saved request is unchanged", async () => {
    const t = await setup(); const before = await t.context();
    await t.harness.behavior.callAgentTool("workflow_board_set_task", t.task, t.agent);
    expect((await t.context()).taskRevision).toBe(before.taskRevision);
  });

  it.each([{ checks: [] }, { checks: [{ name: "other", status: "passed", evidence: "passed" }] }, { checks: [{ name: "API regression", status: "skipped", evidence: "not available" }] }])(
    "rejects incomplete required check coverage: %j", async ({ checks }) => {
      const t = await setup();
      await expect(t.submit({ ...await t.receipt(), checks })).rejects.toThrow(/Required check/i);
      expect(t.stage()).toBe("tdd");
    },
  );

  it("rejects a passing check with no evidence", async () => {
    const t = await setup(); const receipt = await t.receipt(); receipt.checks[0]!.evidence = "";
    await expect(t.submit(receipt)).rejects.toThrow(/evidence/i);
  });

  it("allows an optional skipped check with a reason while required checks pass", async () => {
    const t = await setup(); const receipt = await t.receipt();
    await t.submit({ ...receipt, checks: [...receipt.checks, { name: "Optional browser check", status: "skipped", evidence: "This change has no UI." }] });
    await t.idle(); expect(t.stage()).toBe("quality");
  });

  it("rejects completion from another thread in the same worktree", async () => {
    const t = await setup(); const other = { ...t.root, id: "other", parentThreadId: t.root.id }; t.threads.push(other);
    await expect(t.harness.behavior.callAgentTool("workflow_board_complete_stage", await t.receipt(), { ...t.agent, threadId: other.id })).rejects.toThrow(/assigned stage worker/i);
    await t.idle(other); expect(t.stage()).toBe("tdd");
  });

  it("recovers accepted evidence when the idle event was lost", async () => {
    const t = await setup(); await t.submit(await t.receipt());
    await t.harness.behavior.runCli(["reconcile"]);
    expect(t.stage()).toBe("quality"); expect(t.requests).toHaveLength(1);
  });

  it("keeps paused work paused even with valid evidence", async () => {
    const t = await setup(); await t.submit(await t.receipt());
    await t.harness.behavior.runCli(["pause", "env"]);
    await t.idle(); await t.harness.behavior.runCli(["reconcile"]);
    expect(t.stage()).toBe("tdd"); expect(t.requests).toHaveLength(0);
  });
});
