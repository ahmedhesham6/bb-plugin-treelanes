import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { kindTemplate } from "./task-kinds";
import { makeWorkspaceSdk, shippedSkills } from "./test-workspace";
import type { ProviderInfo, ThreadEventRow } from "@get-bb/plugin-sdk";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

async function setup(assigned = true, settings: Record<string, string | boolean> = {}) {
  const snapshot = makeWorkspaceSdk({ files: { "src/file.ts": { content: "new" } } });
  const root = {
    ...makeThreadResponse({ id: "root", projectId: "project", parentThreadId: null, status: "idle" }),
    environmentId: "env", environmentName: "test", environmentBranchName: "feat/test",
    environmentWorkspaceDisplayKind: "managed-worktree" as const,
  };
  const threads = [root];
  const visibility = { hideWorkers: false, failNextSpawnAfterCreate: false, validateParents: false };
  const sends: Array<{ threadId: string; mode?: string; model?: string; reasoningLevel?: string }> = [];
  const retries: Array<{ threadId: string; turnRequestId?: string }> = [];
  const failedRequests = new Map<string, string>();
  const requests: Array<{ prompt?: string; providerId?: string; model?: string; reasoningLevel?: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "treelanes", agentSkillIds: shippedSkills,
    settings: { startInDesign: false, useInitiatingThread: false, ...settings },
    sdk: {
      providers: {
        list: async () => [],
        models: async () => ({ modelLoadError: null, permissionCeiling: "auto", providers: ["codex", "claude-code"].map(id => ({ id, available: true } as ProviderInfo)), selectedOnlyModels: [],
          models: ["small", "large", "claude-fable-5-1", "gpt-5.6-sol"].map(model => ({ id: model, model, displayName: model, description: "Test model", isDefault: false,
            defaultReasoningEffort: "low" as const, supportedReasoningEfforts: [{ reasoningEffort: "low" as const, description: "Low" }, { reasoningEffort: "high" as const, description: "High" }] })) }),
      },
      skills: { list: async () => ({ skills: [{ id: "test-skill", name: "tdd", filePath: "/skills/tdd/SKILL.md", description: "Test first", manageable: false, pluginId: null, provider: null, registrySkillId: null, scope: "bb-user" }] }) },
      threads: {
        send: async request => { sends.push(request); return { ok: true }; },
        get: async ({ threadId }) => threads.find(t => t.id === threadId)!,
        list: async () => visibility.hideWorkers ? [root] : threads,
        interactions: { list: async () => [] }, queuedMessages: { list: async () => [] },
        events: { list: async ({ threadId }) => [{ type: "client/turn/requested", data: { requestId: failedRequests.get(threadId) ?? `${threadId}-failed` } }] as ThreadEventRow[] },
        retry: async (request) => { retries.push(request); threads.find(t => t.id === request.threadId)!.status = "active";
          return { ok: true, delivery: "sent", attempt: retries.length + 1, turnRequestId: `retry-${retries.length}` }; },
        defaultExecutionOptions: async () => ({ model: "gpt-5.6-sol", reasoningLevel: "high", permissionMode: "auto", source: "client/turn/start" }),
        spawn: async (request) => {
          requests.push(request);
          const parent = threads.find(thread => thread.id === request.parentThreadId);
          if (visibility.validateParents && (!parent || parent.archivedAt || parent.deletedAt)) throw new Error("HTTP 400: Parent thread is invalid");
          const worker = { ...root, visibility: request.visibility ?? parent?.visibility ?? "visible", providerId: request.providerId ?? root.providerId, id: `worker-${requests.length}`, title: request.title ?? "worker", parentThreadId: request.parentThreadId ?? root.id };
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
  if (assigned) await harness.behavior.callAgentTool("treelanes_move_card", { stage: "tdd" }, agent);
  const task = { deliveryTarget: "local" as const, outcome: "Fix the reported bug", scope: ["src/api.ts"], decisions: ["Keep the existing API"],
    requiredChecks: ["API regression"], allowedActions: ["Edit and test"], confirmations: ["User requested fix in root"], testInterfaces: ["public API"] };
  if (assigned) await harness.behavior.callAgentTool("treelanes_set_task", task, agent);
  const context = async () => JSON.parse(await harness.behavior.callAgentTool("treelanes_get_context", {}, agent) as string);
  const receipt = async () => {
    const ctx = await context();
    return { stage: "tdd", stageUpdatedAt: ctx.stageUpdatedAt, taskRevision: ctx.taskRevision, workspaceDigest: ctx.workspaceDigest,
      checks: [{ name: "API regression", status: "passed", evidence: "npm test -- api: 3 tests passed" }],
      decisionsResolved: true, openFindings: [], summary: "API regression fixed and tested." };
  };
  const submit = (value: unknown) => harness.behavior.callAgentTool("treelanes_complete_stage", value, agent);
  const idle = (thread = root) => harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Verified.\n[workflow:tdd-complete]" });
  const stage = () => (bb.storage.database().prepare("SELECT stage FROM worktree_cards WHERE environment_id = 'env'").get() as { stage: string }).stage;
  return { snapshot, bb, harness, root, threads, visibility, requests, sends, retries, failedRequests, agent, task, context, receipt, submit, idle, stage };
}

async function atPrWatch() {
  const t = await setup(false);
  await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: { ...t.task, deliveryTarget: "pr" } }, t.agent);
  const planner = { ...t.agent, threadId: t.threads[1]!.id };
  const steps = ["tdd", "quality", "simplify", "pr"].map(stage => ({ id: stage, title: stage, stage,
    instructions: "Complete and check", checks: ["API regression"],
    execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded work" } }));
  await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Full flow", steps } }, planner);
  await t.harness.behavior.runSchedule("reconcile-worktrees");
  for (const stage of ["tdd", "quality", "simplify"]) {
    const worker = t.threads.at(-1)!;
    const ctx = await t.context();
    await t.harness.behavior.callAgentTool("treelanes_complete_stage", { ...await t.receipt(), stage,
      taskRevision: ctx.taskRevision, stageUpdatedAt: ctx.stageUpdatedAt }, { ...t.agent, threadId: worker.id });
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: worker, lastAssistantText: "Checks complete" });
  }
  expect(t.stage()).toBe("pr");
  return { ...t, planner, steps };
}

describe("reopen PR Watch", () => {
  it.each(["user", "receipt"])("keeps history and the same orchestrator through a new cycle after reload and %s start", async trigger => {
    const t = await atPrWatch();
    const before = await t.context();
    const input = { taskRevision: before.taskRevision, reason: "User requested a longer retry window and full workflow" };
    const result = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_reopen", input, t.planner) as string);
    expect(result).toMatchObject({ stage: "design", taskRevision: before.taskRevision + 1, ownerThreadId: t.planner.threadId });
    const ctx = await t.context();
    expect(ctx.task).toEqual({ ...before.task, setup: undefined, deliveryStages: undefined });
    expect(ctx.activeStep).toBeNull();
    expect(ctx.completedStepIds).toEqual([]);
    expect(ctx.automaticSetup.kind).toBe("reopen");
    expect(t.bb.storage.database().prepare("SELECT * FROM worktree_stage_results").all()).toHaveLength(3);
    const previous = t.bb.storage.database().prepare("SELECT context_json FROM worktree_task_versions WHERE revision = ?").get(before.taskRevision) as { context_json: string };
    expect(JSON.parse(previous.context_json)).toEqual(before.task);
    await expect(t.harness.behavior.callAgentTool("treelanes_reopen", input, t.planner)).rejects.toThrow();
    const baseReceipt = await t.receipt();
    const next = await t.harness.lifecycle.reload(plugin);
    disposals.push(() => next.harness.lifecycle.dispose());
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(5);
    expect(t.sends).toHaveLength(0);
    await next.harness.behavior.callAgentTool("treelanes_set_task", { ...ctx.task, outcome: "Cover the longer retry window" }, t.planner);
    if (trigger === "user") await next.harness.behavior.callAgentTool("treelanes_start", {}, t.planner);
    else {
      const design = JSON.parse(await next.harness.behavior.callAgentTool("treelanes_get_context", {}, t.planner) as string);
      await next.harness.behavior.callAgentTool("treelanes_complete_stage", { ...baseReceipt, stage: "design", checks: [],
        taskRevision: design.taskRevision, stageUpdatedAt: design.stageUpdatedAt }, t.planner);
      await next.harness.behavior.emitThreadEvent("thread.idle", { thread: t.threads[1]!, lastAssistantText: "Design checked" });
    }
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]?.threadId).toBe(t.planner.threadId);
    await next.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Extended retry", steps: t.steps.map(s => ({ ...s, id: `reopen-${s.id}` })) } }, t.planner);
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    const fresh = JSON.parse(await next.harness.behavior.callAgentTool("treelanes_get_context", {}, t.planner) as string);
    expect(fresh.stage).toBe("tdd");
    expect(fresh.activeStep.id).toBe("reopen-tdd");
    expect(t.requests).toHaveLength(6);
    expect(t.threads.at(-1)!.parentThreadId).toBe(t.planner.threadId);
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(6);
    for (const stage of ["tdd", "quality", "simplify"]) {
      const worker = t.threads.at(-1)!;
      const ctx = JSON.parse(await next.harness.behavior.callAgentTool("treelanes_get_context", {}, t.planner) as string);
      expect(ctx.stage).toBe(stage);
      await next.harness.behavior.callAgentTool("treelanes_complete_stage", { ...baseReceipt, stage,
        taskRevision: ctx.taskRevision, stageUpdatedAt: ctx.stageUpdatedAt }, { ...t.agent, threadId: worker.id });
      await next.harness.behavior.emitThreadEvent("thread.idle", { thread: worker, lastAssistantText: "Fresh checks complete" });
    }
    const final = JSON.parse(await next.harness.behavior.callAgentTool("treelanes_get_context", {}, t.planner) as string);
    expect(final.stage).toBe("pr");
    expect(final.activeStep.id).toBe("reopen-pr");
    expect(t.requests).toHaveLength(9);
  });

  it.each(["wrong-owner", "stale", "paused", "active-worker", "question", "queued", "missing-orchestrator", "race"])("rejects %s without changing the saved task", async guard => {
    const t = await atPrWatch();
    const before = await t.context();
    const input = { taskRevision: before.taskRevision, reason: "User requested changed work" };
    let caller = t.planner;
    if (guard === "wrong-owner") caller = t.agent;
    if (guard === "stale") input.taskRevision--;
    if (guard === "paused") t.bb.storage.database().prepare("INSERT INTO worktree_controls VALUES ('env', 1)").run();
    if (guard === "active-worker") t.threads.at(-1)!.status = "active";
    if (guard === "question") t.harness.sdk.stub("threads.interactions.list", async () => [{ id: "pending" }]);
    if (guard === "queued") t.harness.sdk.stub("threads.queuedMessages.list", async () => [{ id: "queued" }]);
    if (guard === "missing-orchestrator") t.threads[1]!.archivedAt = 123;
    if (guard === "race") t.harness.sdk.stub("threads.queuedMessages.list", async () => {
      t.bb.storage.database().prepare("INSERT OR REPLACE INTO worktree_controls VALUES ('env', 1)").run();
      return [];
    });
    await expect(t.harness.behavior.callAgentTool("treelanes_reopen", input, caller)).rejects.toThrow();
    const after = await t.context();
    expect(after.taskRevision).toBe(before.taskRevision);
    expect(after.task).toEqual(before.task);
    expect(after.stage).toBe("pr");
    expect(after.automaticSetup.id).toBe(before.automaticSetup.id);
  });

  it("lets the PR owner reopen through the CLI but assigns Design to the saved orchestrator", async () => {
    const t = await atPrWatch();
    const ctx = await t.context();
    const result = await t.harness.behavior.runCli(["reopen", JSON.stringify({ taskRevision: ctx.taskRevision, reason: "User requested changed work" })],
      { ...t.agent, threadId: t.threads.at(-1)!.id });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({ stage: "design", ownerThreadId: t.planner.threadId });
  });

  it("does not reopen implementation or manual work", async () => {
    const t = await setup();
    await expect(t.harness.behavior.callAgentTool("treelanes_reopen", { taskRevision: 1, reason: "Changed work" }, t.agent)).rejects.toThrow();
    expect(t.stage()).toBe("tdd");
  });
});

describe("saved stage evidence", () => {
  it("does not let a non-task failure classification excuse an unresolved task finding", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, deliveryTarget: "pr" }, t.agent);
    await expect(t.submit({ ...await t.receipt(), openFindings: ["The new API leaks another tenant's data"],
      checks: [{ name: "API regression", status: "failed", evidence: "Failure observed",
        nonTaskFailure: { kind: "base", diagnosis: "Base suite also has failures" } }] })).rejects.toThrow(/required findings/);
    await t.idle();
    expect(t.stage()).toBe("tdd");
  });

  it.each(["base", "environment"])("continues PR delivery with a diagnosed %s failure and retains its failed status", async kind => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, deliveryTarget: "pr", requiredChecks: ["API regression", "Full backend suite"] }, t.agent);
    const receipt = await t.receipt();
    receipt.checks.push({ name: "Full backend suite", status: "failed", evidence: "Full suite exits 1; task regression passes", nonTaskFailure: {
      kind, diagnosis: kind === "base" ? "The same failure reproduces on base revision abc123 with unchanged test inputs." : "The suite cannot reach its required test database; local task tests use verified fixtures.",
    } } as typeof receipt.checks[number]);
    await t.submit(receipt);
    await t.idle();
    expect(t.stage()).toBe("quality");
    const saved = t.bb.storage.database().prepare("SELECT evidence_json FROM worktree_stage_results WHERE environment_id = 'env' ORDER BY stage_updated_at LIMIT 1").get() as { evidence_json: string };
    expect(JSON.parse(saved.evidence_json).checks[1]).toMatchObject({ status: "failed", nonTaskFailure: { kind } });
  });

  it.each(["receipt", "user"])("waits in Design and uses the original orchestrator after %s start", async trigger => {
    const t = await setup(false, { startInDesign: true, useInitiatingThread: true });
    await t.harness.behavior.callRpc("saveTaskMap", { choices: { orchestrator: { providerId: "codex", model: "large", reasoningLevel: "high" } } });
    t.root.providerId = "codex";
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    expect(t.stage()).toBe("design");
    expect((await t.context()).orchestratorThreadId).toBe(t.root.id);
    expect(t.requests).toHaveLength(0);
    await t.idle();
    expect(t.stage()).toBe("design");
    expect(t.sends).toHaveLength(0);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.stage()).toBe("design");
    expect(t.requests).toHaveLength(0);
    if (trigger === "receipt") {
      const ctx = await t.context();
      expect(ctx.requiredChecks).toEqual([]);
      await t.submit({ ...await t.receipt(), stage: "design", checks: [], decisionsResolved: true });
      await t.harness.behavior.emitThreadEvent("thread.idle", { thread: t.root, lastAssistantText: "Design accepted.\n[workflow:grilling-complete]" });
    } else {
      await t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent);
    }
    expect(t.stage()).toBe("tdd");
    expect(t.requests).toHaveLength(0);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]).toMatchObject({ threadId: t.root.id, model: "large", reasoningLevel: "high" });
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix and check", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix the bug", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
    }] } }, t.agent);
    await t.idle();
    expect(t.requests).toHaveLength(1);
    expect(t.threads[1]!.parentThreadId).toBe(t.root.id);
    expect((await t.context()).orchestratorThreadId).toBe(t.root.id);
    await t.idle();
    expect(t.requests).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
    const next = await t.harness.lifecycle.reload(plugin);
    disposals.push(() => next.harness.lifecycle.dispose());
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    const restored = JSON.parse(await next.harness.behavior.callAgentTool("treelanes_get_context", {}, t.agent) as string);
    expect(restored.orchestratorThreadId).toBe(t.root.id);
    expect(t.requests).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it.each([true, false])("accepts only a matching duplicate stage list: %s", async matching => {
    const t = await setup();
    const steps = ["tdd", "quality", "simplify", "pr"].map(stage => ({ id: stage, title: stage, stage,
      instructions: "Follow the saved task", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded task" } }));
    const candidate = { ...t.task, deliveryStages: matching ? ["tdd", "quality", "simplify", "pr"] : ["tdd", "quality", "pr"],
      stageChecks: { tdd: ["Keep the extra regression"] }, setup: { summary: "Delivery", steps } };
    const save = () => t.harness.behavior.callAgentTool("treelanes_set_task", candidate, t.agent);
    if (!matching) {
      await expect(save()).rejects.toThrow(/conflicts with setup/);
      expect((await t.context()).task.setup).toBeUndefined();
      return;
    }
    await save();
    const ctx = await t.context();
    expect(ctx.task.deliveryStages).toBeUndefined();
    expect(ctx.task.setup.steps).toEqual(steps);
    expect(ctx.requiredChecks).toContain("Keep the extra regression");
    await save();
    expect((await t.context()).taskRevision).toBe(ctx.taskRevision);
    expect(t.requests).toHaveLength(0);
  });

  it("saves task map choices and binds the planner to them", async () => {
    const t = await setup(false, { useInitiatingThread: true });
    t.root.providerId = "codex";
    const choices = { "feature/build": { providerId: "codex", model: "large", reasoningLevel: "high" } };
    await t.harness.behavior.callRpc("saveTaskMap", { choices });
    const skills = kindTemplate({ kind: "feature", deliveryTarget: "pr" }).flatMap(step => step.skills);
    t.harness.inspection.sdk.stub("skills.list", async () => ({ skills: [...new Set(skills)].map(id => ({ id, name: id, filePath: `/skills/${id}/SKILL.md`,
      description: "Shipped", manageable: false, pluginId: "treelanes", provider: null, registrySkillId: null, scope: "plugin" })) }) as never);
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: { ...t.task, kind: "feature", deliveryTarget: "pr" } }, t.agent);
    expect((await t.context()).stepChoices).toEqual({ build: choices["feature/build"] });
    const plan = (model: string) => ({ setup: { summary: "Feature", steps: kindTemplate({ kind: "feature", deliveryTarget: "pr" }).map(({ skills, ...step }) =>
      ({ ...step, execution: { providerId: "codex", model: step.id === "build" ? model : "small", reasoningLevel: "high", skills, reason: "Fits." } })) } });
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", plan("small"), t.agent))
      .rejects.toThrow('Template step "build" must use model "large" from the Settings task map.');
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", plan("large"), t.agent);
    await t.idle();
    expect(t.requests.at(-1)).toMatchObject({ providerId: "codex", model: "large", reasoningLevel: "high" });
    const next = await t.harness.lifecycle.reload(plugin);
    disposals.push(() => next.harness.lifecycle.dispose());
    expect(await next.harness.behavior.callRpc("getTaskMap", {})).toMatchObject({ choices });
  });

  it("reports unavailable saved choices in Settings and health", async () => {
    const t = await setup();
    t.harness.inspection.sdk.stub("providers.list", async () => [
      { id: "codex", displayName: "Codex", available: true }, { id: "claude-code", displayName: "Claude Code", available: false },
    ] as never);
    const map = await t.harness.behavior.callRpc("saveTaskMap", { choices: {
      "bug-fix/fix": { providerId: "codex", model: "retired" }, titles: { providerId: "claude-code" },
    } }) as { problems: unknown[] };
    expect(map.problems).toEqual([
      { slot: "bug-fix/fix", message: "Model retired is not available for codex." },
      { slot: "titles", message: "Harness claude-code is not available." },
    ]);
    const health = JSON.parse((await t.harness.behavior.runCli(["health", "project"])).stdout!);
    expect(health.slice(0, 2)).toEqual([
      { status: "task-map-unavailable", slot: "bug-fix/fix", error: "Model retired is not available for codex." },
      { status: "task-map-unavailable", slot: "titles", error: "Harness claude-code is not available." },
    ]);
  });

  it("rejects a saved setup that breaks the kind template", async () => {
    const t = await setup();
    const [build, quality] = kindTemplate({ kind: "feature" }).map(({ skills, ...step }) =>
      ({ ...step, execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills, reason: "Fits." } }));
    const save = (setup: object) => t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, kind: "feature", setup }, t.agent);
    await expect(save({ summary: "Build and review", steps: [build, quality] })).rejects.toThrow(/simplify/);
    await save({ summary: "Build and review", steps: [build, quality], skipped: [{ stepId: "simplify", reason: "One-line change." }] });
    expect((await t.context()).task.setup.skipped).toEqual([{ stepId: "simplify", reason: "One-line change." }]);
  });

  it("keeps a stage worker visible when its task parent is hidden", async () => {
    const t = await setup();
    t.root.visibility = "hidden";
    await t.submit(await t.receipt());
    await t.idle();
    expect(t.stage()).toBe("quality");
    expect(t.threads.at(-1)!.visibility).toBe("visible");
    expect(t.root.visibility).toBe("hidden");
  });

  it.each(["archived", "deleted", "missing", "in another project"])("dispatches the next step under the task parent when its orchestrator is %s", async state => {
    const t = await setup(false);
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    const planner = t.threads[1]!;
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix and check the API", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
    }] } }, { ...t.agent, threadId: planner.id });
    if (state === "archived") planner.archivedAt = Date.now();
    else if (state === "deleted") planner.deletedAt = Date.now();
    else if (state === "missing") t.threads.splice(t.threads.indexOf(planner), 1);
    else planner.projectId = "other-project";
    t.visibility.validateParents = true;
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: planner, lastAssistantText: "Plan saved" });
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]).toMatchObject({ parentThreadId: t.root.id });
    expect(t.threads).toHaveLength(state === "missing" ? 2 : 3);
    expect((await t.context()).ownerThreadId).toBe(t.threads.at(-1)!.id);
  });

  it("lets the orchestrator read the saved task during a workspace capture failure", async () => {
    const t = await setup(false);
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    t.harness.sdk.stub("environments.status", async () => { throw new Error("502 workspace unavailable"); });
    const context = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, planner) as string);
    expect(context.task).toMatchObject(t.task);
    expect(context.workspaceDigest).toBeUndefined();
    expect(context.automaticSetup.thread_id).toBe(planner.threadId);
    await expect(t.context()).rejects.toThrow(/502|unavailable/);
  });

  it("loads plugin skills for board threads and only delivery and ponytail for the setup worker", async () => {
    const t = await setup(false);
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    const configure = (thread: typeof t.root) => t.harness.behavior.resolveAgentConfiguration({
      thread: { id: thread.id, title: thread.title, parentThreadId: thread.parentThreadId, sourceThreadId: null },
      project: { id: "project", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "env", name: "test", path: "/srv/worktree", workspaceProvisionType: "managed-worktree", branchName: "feat/test" },
      host: { id: "host", name: "Host" }, provider: { id: "codex", model: "small" }, origin: { kind: null, pluginId: null },
    });
    expect((await configure(t.threads[1]!)).skills).toEqual(["delivery", "ponytail"]);
    const board = await configure(t.root);
    expect(board.tools.length).toBeGreaterThan(0);
    expect(board.skills).toEqual(shippedSkills);
  });

  it("automatically reaches PR Watch after TDD, Quality and Simplify, and keeps PR when the plan changes", async () => {
    const t = await setup(false);
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: { ...t.task, deliveryTarget: undefined } }, t.agent);
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, t.agent) as string);
    expect(t.threads[1]!.visibility).toBe("visible");
    expect(ctx.task.deliveryTarget).toBe("pr");
    expect(t.requests[0]!.prompt).toContain("references/orchestration.md");
    expect(t.requests[0]!.prompt!.length).toBeLessThan(1000);
    const stages = ["tdd", "quality", "simplify", "pr"];
    const steps = stages.map(stage => ({ id: stage, title: stage, stage, instructions: "Complete the scoped work and submit current evidence",
      checks: ["API regression"], execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded test assignment" } }));
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Missing PR", steps: steps.slice(0, 3) } }, planner)).rejects.toThrow(/PR Watch/);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Automatic delivery", steps } }, planner);
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: t.threads[1]!, lastAssistantText: "Plan saved" });
    for (const [index, stage] of stages.slice(0, 3).entries()) {
      const worker = t.threads.at(-1)!;
      const agent = { ...t.agent, threadId: worker.id };
      const current = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, agent) as string);
      expect(current.stage).toBe(stage);
      if (stage === "tdd") {
        await expect(t.harness.behavior.callAgentTool("treelanes_set_task", { ...current.task, setup: { ...current.task.setup, steps: steps.slice(0, 3) } }, agent)).rejects.toThrow(/PR Watch/);
        await expect(t.harness.behavior.callAgentTool("treelanes_set_task", { ...current.task, deliveryTarget: "local" }, agent)).rejects.toThrow(/PR Watch/);
        const changed = structuredClone(current.task); changed.setup.steps[2].instructions = "Simplify only where useful; verify unchanged behavior";
        await t.harness.behavior.callAgentTool("treelanes_set_task", changed, agent);
      }
      if (stage === "quality") {
        const shortened = structuredClone(current.task);
        shortened.setup.steps[0].instructions = "Use the prior receipt. This step is complete.";
        const saved = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_set_task", shortened, agent) as string);
        expect(saved.task.setup.steps[0]).toEqual(current.task.setup.steps[0]);
        expect(saved.task.setup.steps.at(-1).stage).toBe("pr");
      }
      const fresh = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, agent) as string);
      await t.harness.behavior.callAgentTool("treelanes_complete_stage", { stage, stageUpdatedAt: fresh.stageUpdatedAt,
        taskRevision: fresh.taskRevision, workspaceDigest: fresh.workspaceDigest,
        checks: [{ name: "API regression", status: "passed", evidence: "API regression passed on current files" }],
        decisionsResolved: true, openFindings: [], summary: "Stage checked" }, agent);
      // No manual move, start, or confirmation at any handoff; an idle event is enough.
      await t.harness.behavior.emitThreadEvent("thread.idle", { thread: worker, lastAssistantText: "Checks complete" });
      const next = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, t.agent) as string);
      expect(next.stage).toBe(stages[index + 1]);
      expect(t.requests).toHaveLength(index + 3);
    }
    expect(t.threads.slice(2).every(worker => worker.parentThreadId === planner.threadId)).toBe(true);
    expect(t.requests.at(-1)!.prompt).toContain("/babysit-pr");
    expect(t.requests).toHaveLength(5); // One setup worker and one worker per stage.
  });

  it("continues a normal worker that ended without a receipt, but never repeats that continuation", async () => {
    const t = await setup();
    const task = { ...t.task, deliveryTarget: "pr" };
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task }, t.agent);
    const steps = ["tdd", "quality", "simplify", "pr"].map(stage => ({ id: stage, title: stage, stage, instructions: "Complete and record the stage", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded work" } }));
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Full flow", steps } }, { ...t.agent, threadId: t.threads[1]!.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = t.threads[2]!;
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    t.harness.sdk.stub("threads.events.list", async () => [{ id: "normal-end", threadId: worker.id, seq: 20,
      createdAt: Date.now(), type: "turn/completed", data: { status: "completed" } }]);
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: worker, lastAssistantText: "Tests pass. Ready for review." });
    expect(t.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(t.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ threadId: worker.id });
    const next = await t.harness.lifecycle.reload(plugin); disposals.push(() => next.harness.lifecycle.dispose());
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(next.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(t.requests).toHaveLength(2);
    next.harness.sdk.stub("threads.events.list", async () => [{ id: "stop", threadId: worker.id, seq: 21,
      createdAt: Date.now(), type: "system/thread/interrupted", data: { reason: "manual-stop" } }]);
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(next.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    const agent = { ...t.agent, threadId: worker.id };
    const ctx = JSON.parse(await next.harness.behavior.callAgentTool("treelanes_get_context", {}, agent) as string);
    await expect(next.harness.behavior.callAgentTool("treelanes_complete_stage", { stage: ctx.stage, stageUpdatedAt: ctx.stageUpdatedAt,
      taskRevision: ctx.taskRevision, workspaceDigest: ctx.workspaceDigest, decisionsResolved: true, openFindings: ["Local service test fails"],
      checks: [{ name: "API regression", status: "failed", evidence: "Local test service exits early" }], summary: "Need diagnosis" }, agent)).rejects.toThrow();
    next.harness.sdk.stub("threads.events.list", async () => [{ id: "blocked-end", threadId: worker.id, seq: 22,
      createdAt: Date.now() + 1, type: "turn/completed", data: { status: "completed" } }]);
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(next.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(next.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ threadId: t.threads[1]!.id });
    expect(JSON.stringify(next.harness.inspection.sdk.callsTo("threads.send"))).toContain("task orchestrator");
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(next.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(t.requests).toHaveLength(2);
  });

  it.each(["quality", "simplify"])("continues an in-scope %s repair automatically in the same worker", async stage => {
    const t = await setup();
    t.bb.storage.database().prepare("UPDATE worktree_cards SET stage = ? WHERE environment_id = 'env'").run(stage);
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    t.harness.sdk.stub("threads.events.list", async () => [{ id: "finished-turn", threadId: "root", seq: 20,
      createdAt: Date.now() + 1, type: "turn/completed", data: { status: "completed" } }]);
    const evidence = { ...await t.receipt(), stage, checks: [{ name: "API regression", status: "failed", evidence: "New branch regression" }],
      nextAction: "Fix the branch regression and rerun API regression" };
    const response = await t.submit(evidence);
    expect(JSON.parse(String(response))).toMatchObject({ recorded: false, action: "repair" });
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: t.root, lastAssistantText: "Repair remains" });
    expect(t.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    const request = t.harness.inspection.sdk.callsTo("threads.send")[0]![0] as { threadId: string; input: { text: string }[] };
    expect(request.threadId).toBe("root");
    expect(request.input[0]!.text).toContain(`saved ${stage} repair`);
    expect(t.requests).toHaveLength(0);
    expect(t.stage()).toBe(stage);
  });

  it("continues a concrete TDD repair in the same thread once across reload, then advances on fresh evidence", async () => {
    const t = await setup();
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    t.harness.sdk.stub("threads.events.list", async () => [{
      id: "completed-turn", threadId: "root", seq: 20, createdAt: Date.now() + 1,
      type: "turn/completed", data: { status: "completed" },
    }]);
    const result = await t.submit({ ...await t.receipt(),
      checks: [{ name: "API regression", status: "failed", evidence: "Parser accepts a malformed entry" }],
      nextAction: "Reject the malformed entry in the existing parser, then rerun API regression",
    });
    expect(JSON.parse(String(result))).toMatchObject({ recorded: false, action: "repair" });
    await t.idle();
    expect(t.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(t.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ threadId: "root", mode: "start" });
    expect(t.stage()).toBe("tdd");
    expect(t.requests).toHaveLength(0);
    const passingEvidence = await t.receipt();
    const next = await t.harness.lifecycle.reload(plugin);
    disposals.push(() => next.harness.lifecycle.dispose());
    await next.harness.behavior.runSchedule("reconcile-worktrees");
    expect(next.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await next.harness.behavior.callAgentTool("treelanes_complete_stage", passingEvidence, t.agent);
    await next.harness.behavior.emitThreadEvent("thread.idle", { thread: t.root, lastAssistantText: "[workflow:tdd-complete]" });
    expect(t.requests).toHaveLength(1);
  });

  it.each(["pause", "interrupted", "newer-turn", "question", "queued", "active", "disabled", "fresh-pass", "new-task"])("does not continue a TDD repair after %s", async (gate) => {
    const t = await setup();
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    t.harness.sdk.stub("threads.events.list", async () => [{
      id: "last-event", threadId: "root", seq: 20, createdAt: Date.now() + 1,
      type: gate === "newer-turn" ? "client/turn/requested" : "turn/completed",
      data: { status: gate === "interrupted" ? "interrupted" : "completed" },
    }]);
    await t.submit({ ...await t.receipt(),
      checks: [{ name: "API regression", status: "failed", evidence: "Parser rejects a valid entry" }],
      nextAction: "Fix the entry parser and rerun API regression",
    });
    if (gate === "pause") await t.harness.behavior.runCli(["pause", "env"]);
    if (gate === "active") t.root.status = "active";
    if (gate === "question") t.harness.sdk.stub("threads.interactions.list", async () => [{ id: "question" }]);
    if (gate === "queued") t.harness.sdk.stub("threads.queuedMessages.list", async () => [{ id: "queued" }]);
    if (gate === "disabled") await t.harness.behavior.setSettings({ autoAdvanceImplementation: false });
    if (gate === "fresh-pass") await t.submit(await t.receipt());
    if (gate === "new-task") await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, outcome: "Changed scope" }, t.agent);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("never sends the same repair twice when the first send result is unknown", async () => {
    const t = await setup();
    t.harness.sdk.stub("threads.send", async () => { throw new Error("response lost"); });
    t.harness.sdk.stub("threads.events.list", async () => [{
      id: "done", threadId: "root", seq: 20, createdAt: Date.now() + 1,
      type: "turn/completed", data: { status: "completed" },
    }]);
    const failed = { ...await t.receipt(), checks: [{ name: "API regression", status: "failed", evidence: "Parser failure" }],
      nextAction: "Repair parser and rerun API regression" };
    await t.submit(failed);
    await Promise.all([t.idle(), t.harness.behavior.runSchedule("reconcile-worktrees")]);
    await t.submit({ ...failed, summary: "Same failure, reported again" });
    await t.idle();
    expect(t.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    const health = await t.harness.behavior.runCli(["health", "project"]);
    expect(JSON.parse(String(health.stdout))).toEqual([expect.objectContaining({ status: "repair-uncertain" })]);
    expect(t.requests).toHaveLength(0);
  });

  it("records a required human decision even when a repair action was supplied", async () => {
    const t = await setup();
    await t.submit(await t.receipt());
    await expect(t.submit({ ...await t.receipt(), decisionsResolved: false,
      nextAction: "Implement the unapproved API choice",
    })).rejects.toThrow();
    expect((await t.context()).blockedAttempt.evidence.decisionsResolved).toBe(false);
    await t.idle();
    expect(t.stage()).toBe("tdd");
    expect(t.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(t.requests).toHaveLength(0);
  });

  it("preserves accepted long check names through setup, execution, and completion", async () => {
    const t = await setup();
    const name = "Required integration check: " + "x".repeat(996);
    expect(name.length).toBe(1024);
    const task = { ...t.task, requiredChecks: [name] };
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task }, t.agent);
    const proposal = { setup: { summary: "Run the exact accepted check", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Keep the accepted scope and run the exact check", checks: [name],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
    }] } };
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, { ...t.agent, threadId: t.threads[1]!.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = { ...t.agent, threadId: t.threads[2]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    expect(ctx.requiredChecks).toEqual([name]);
    await t.harness.behavior.callAgentTool("treelanes_complete_stage", {
      stage: ctx.stage, stageUpdatedAt: ctx.stageUpdatedAt, taskRevision: ctx.taskRevision, workspaceDigest: ctx.workspaceDigest,
      checks: [{ name, status: "passed", evidence: "Exact accepted integration check passes" }],
      decisionsResolved: true, openFindings: [], summary: "Checked the requested fix",
    }, worker);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect((await t.context()).setupComplete).toBe(true);
    const finishedBoard = await t.harness.behavior.callRpc("getBoard", { projectId: "project" }) as { cards: Array<{ note: string }> };
    expect(finishedBoard.cards[0]?.note).toContain("Complete locally. No PR step is planned.");
    expect(t.requests).toHaveLength(2);
  });

  it.each([[], ["--help"], ["-h"], ["help"]])("returns complete CLI help without starting workflow work: %j", async (...args) => {
    const t = await setup(false);
    const result = await t.harness.behavior.runCli(args);
    expect(result.exitCode).toBe(0);
    for (const command of ["deliver", "apply-setup", "recover", "context"]) expect(result.stdout).toContain(command);
    expect(result.stdout).toContain("nextAction");
    expect(t.requests).toHaveLength(0);
  });

  it("reads an unassigned worktree without creating a card, capturing files, or starting work", async () => {
    const t = await setup(false);
    const context = await t.context();
    expect(context).toMatchObject({ status: "unassigned", environmentId: "env", stage: null, stageUpdatedAt: null,
      ownerThreadId: null, task: null, taskRevision: 0, workspaceDigest: null });
    expect(context.instruction).toContain("deliver");
    expect(context.instruction).toContain("research");
    const cli = await t.harness.behavior.runCli(["context"], t.agent);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(String(cli.stdout))).toEqual(context);
    expect(t.requests).toHaveLength(0);
    expect(t.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM worktree_cards").get()).toEqual({ count: 0 });
    expect(t.harness.inspection.sdk.callsTo("environments.diff")).toHaveLength(0);
    await expect(t.harness.behavior.callAgentTool("treelanes_set_task", t.task, t.agent)).rejects.toThrow(/Assign a Worktree Stage/);
    await expect(t.submit({ stage: "tdd", stageUpdatedAt: 0, taskRevision: 0, workspaceDigest: "invented",
      checks: [], decisionsResolved: true, openFindings: [], summary: "Not assigned" })).rejects.toThrow(/Assign a Worktree Stage/);
    expect(t.requests).toHaveLength(0);
  });

  it("keeps a rejected TDD result visible and stops unchanged recovery after reload", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
    }] } }, { ...t.agent, threadId: t.threads[1]!.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = { ...t.agent, threadId: t.threads[2]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    const evidence = { ...await t.receipt(), stageUpdatedAt: ctx.stageUpdatedAt,
      checks: [{ name: "API regression", status: "failed", evidence: "25 failures also reproduce on the base branch" }],
      openFindings: ["Base failures outside the accepted scope"] };
    await expect(t.harness.behavior.callAgentTool("treelanes_complete_stage", evidence, worker)).rejects.toThrow();
    const health = await t.harness.behavior.runCli(["health", "project"]);
    expect(JSON.parse(String(health.stdout))).toEqual([expect.objectContaining({ status: "checks-blocked", error: expect.stringContaining("Base failures") })]);
    expect(JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string).blockedAttempt.evidence).toEqual(evidence);
    const board = await t.harness.behavior.callRpc("getBoard", { projectId: "project" }) as { cards: Array<{ note: string; pendingThreadStart: unknown }> };
    expect(board.cards[0]?.note).toContain("Blocked: ");
    expect(board.cards[0]?.pendingThreadStart).toBeNull();
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    t.threads[2]!.status = "error";
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    await t.harness.behavior.runCli(["reconcile", "project"]);
    expect(t.requests).toHaveLength(2);
    await expect(t.harness.behavior.callAgentTool("treelanes_recover", { reason: "The same base failures remain" }, worker)).rejects.toThrow(/nextAction/);
    expect(t.requests).toHaveLength(2);
    expect(next.bb.storage.database().prepare("SELECT stage FROM worktree_cards").get()).toEqual({ stage: "tdd" });
    expect(next.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM worktree_stage_results").get()).toEqual({ count: 0 });
  });

  it("replaces a rejected result with fresh passing evidence without another TDD worker", async () => {
    const t = await setup();
    await expect(t.submit({ ...await t.receipt(), checks: [{ name: "API regression", status: "blocked", evidence: "Local test service unavailable" }] })).rejects.toThrow();
    expect((await t.context()).blockedAttempt).toBeTruthy();
    await t.submit(await t.receipt());
    expect((await t.context()).blockedAttempt).toBeNull();
    await t.idle();
    expect(t.stage()).toBe("quality");
    expect(t.requests).toHaveLength(1);
  });

  it("requires a concrete recovery action for blocked checks and keeps human decisions blocked", async () => {
    const t = await setup();
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
    }] } }, { ...t.agent, threadId: t.threads[1]!.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = { ...t.agent, threadId: t.threads[2]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    const evidence = { ...await t.receipt(), stageUpdatedAt: ctx.stageUpdatedAt, decisionsResolved: false,
      checks: [{ name: "API regression", status: "failed", evidence: "Local parser does not reject zero-length entries" }] };
    await expect(t.harness.behavior.callAgentTool("treelanes_complete_stage", evidence, worker)).rejects.toThrow();
    const recovery = { reason: "Parser regression fails", nextAction: "Bound the local parser entry length and rerun the exact regression" };
    await expect(t.harness.behavior.callAgentTool("treelanes_recover", recovery, worker)).rejects.toThrow(/human decision/);
    await expect(t.harness.behavior.callAgentTool("treelanes_complete_stage", { ...evidence, decisionsResolved: true }, worker)).rejects.toThrow();
    const result = await t.harness.behavior.runCli(["recover", JSON.stringify(recovery)], worker);
    expect(result.exitCode).toBe(0);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    expect(JSON.stringify(t.harness.inspection.sdk.callsTo("threads.send"))).toContain(recovery.nextAction);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
  });

  it("invalidates an earlier passing receipt when the same owner records a blocker", async () => {
    const t = await setup();
    await t.submit(await t.receipt());
    await expect(t.submit({ ...await t.receipt(), openFindings: ["Required behavior still fails"] })).rejects.toThrow();
    await t.idle();
    expect(t.stage()).toBe("tdd");
    expect(t.requests).toHaveLength(0);
  });

  it("does not store blockers from stale or unassigned submissions", async () => {
    const t = await setup();
    const bad = { ...await t.receipt(), openFindings: ["Failed"] };
    t.snapshot.files.set("src/file.ts", { content: "changed" });
    await expect(t.submit(bad)).rejects.toThrow(/stale/);
    expect((await t.context()).blockedAttempt).toBeNull();
    const other = { ...t.root, id: "other" }; t.threads.push(other);
    await expect(t.harness.behavior.callAgentTool("treelanes_complete_stage", { ...await t.receipt(), openFindings: ["Failed"] }, { ...t.agent, threadId: other.id })).rejects.toThrow(/assigned/);
    expect((await t.context()).blockedAttempt).toBeNull();
  });

  it("does not turn a blocked manual task into a new automatic setup", async () => {
    const t = await setup();
    await expect(t.submit({ ...await t.receipt(), openFindings: ["Base failure remains"] })).rejects.toThrow();
    await expect(t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent)).rejects.toThrow(/blocked/i);
    expect(t.requests).toHaveLength(0);
  });

  it("rejects recovery when ownership changes during the pending-input read", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
    }] } }, { ...t.agent, threadId: t.threads[1]!.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = { ...t.agent, threadId: t.threads[2]!.id };
    t.harness.inspection.sdk.stub("threads.interactions.list", async () => {
      t.bb.storage.database().prepare("UPDATE worktree_cards SET owner_thread_id = 'other'").run();
      return [];
    });
    await expect(t.harness.behavior.callAgentTool("treelanes_recover", { reason: "Failure", nextAction: "Fix parser" }, worker)).rejects.toThrow(/changed/);
    expect(t.bb.storage.database().prepare("SELECT recovery_count FROM worktree_delivery_runs").get()).toEqual({ recovery_count: 0 });
    expect(t.requests).toHaveLength(2);
  });

  it("replaces an outdated initial setup once and dispatches only the current task", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    const oldPlanner = { ...t.agent, threadId: t.threads[1]!.id };
    const task = { ...t.task, requiredChecks: [...t.task.requiredChecks, "Security CI"] };
    await t.harness.behavior.callAgentTool("treelanes_set_task", task, t.agent);
    const before = await t.context();
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    t.threads[2]!.status = "active";
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]?.prompt).toContain("treelanes_get_context");
    const plannerContext = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, { ...t.agent, threadId: t.threads[2]!.id }) as string);
    expect(plannerContext.task.requiredChecks).toContain("Security CI");
    const current = await t.context();
    expect(current.automaticSetup).toMatchObject({ kind: "initial", task_revision: before.taskRevision, status: "started", attempts: 1 });
    expect(current.task).toEqual(before.task);
    expect(current.ownerThreadId).toBe(before.ownerThreadId);
    expect(current.stageUpdatedAt).toBe(before.stageUpdatedAt);
    const proposal = { setup: { summary: "Fix and enforce CI", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix and enforce CI", checks: task.requiredChecks,
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } };
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, oldPlanner)).rejects.toThrow(/assigned/);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, { ...t.agent, threadId: t.threads[2]!.id });
    t.threads[2]!.status = "idle";
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(3);
    const workerContext = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, { ...t.agent, threadId: t.threads[3]!.id }) as string);
    expect(workerContext.requiredChecks).toContain("Security CI");
  });

  it.each(["reconcile", "recover"])("repairs a persisted stale initial request through %s after reload", async (method) => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, requiredChecks: [...t.task.requiredChecks, "Security CI"] }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, requiredChecks: [...t.task.requiredChecks, "Required Security CI"] }, t.agent);
    // Persist the state left by the old plugin, using the host's real test database.
    t.bb.storage.database().prepare("UPDATE worktree_setup_requests SET status = 'stale', last_error = 'Task or stage changed'").run();
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    if (method === "recover") {
      await t.harness.behavior.callAgentTool("treelanes_recover", { reason: "Initial setup assignment is stale" }, t.agent);
      expect(t.requests).toHaveLength(1);
    }
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    const current = await t.harness.behavior.callAgentTool("treelanes_get_context", {}, t.agent);
    const context = JSON.parse(current as string);
    expect(context.automaticSetup).toMatchObject({ kind: "initial", status: "started", task_revision: context.taskRevision });
    expect(t.requests[1]?.prompt).toContain(`"taskRevision":${context.taskRevision}`);
    expect(context.task.requiredChecks).toContain("Required Security CI");
    expect(next.bb.storage.database().prepare("SELECT recovery_count FROM worktree_delivery_runs").get()).toEqual({ recovery_count: 0 });
    expect(next.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM worktree_setup_requests").get()).toEqual({ count: 2 });
  });

  it.each(["pause", "live worker", "pending input"])("waits for %s before starting a replacement planner", async (blocker) => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, requiredChecks: [...t.task.requiredChecks, "Security CI"] }, t.agent);
    if (blocker === "pause") await t.harness.behavior.runCli(["pause", "env"]);
    if (blocker === "live worker") t.threads[1]!.status = "active";
    if (blocker === "pending input") Object.assign(t.threads[1]!, { hasPendingInteraction: true });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(1);
    if (blocker === "pause") await t.harness.behavior.runCli(["resume", "env"]);
    t.threads[1]!.status = "idle";
    Object.assign(t.threads[1]!, { hasPendingInteraction: false });
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
  });

  it("does not revive an initial setup after the user changes the stage", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.runCli(["move", "design", t.root.id]);
    expect(t.stage()).toBe("design");
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, requiredChecks: [...t.task.requiredChecks, "Security CI"] }, t.agent);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    await expect(t.harness.behavior.callAgentTool("treelanes_recover", { reason: "Old setup stopped" }, t.agent)).rejects.toThrow();
    expect(t.requests).toHaveLength(1);
    expect(t.stage()).toBe("design");
  });

  it("keeps an idle setup worker for correction without spawning a replacement", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    for (let i = 0; i < 3; i++) await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(1);
    expect(t.retries).toHaveLength(0);
    expect((await t.context()).automaticSetup).toMatchObject({ status: "started", thread_id: t.threads[1]!.id });
  });

  it("resumes only the requested worktree", async () => {
    const t = await setup();
    const other = { ...t.root, id: "other-worker", environmentId: "other-env", status: "error" as const };
    t.threads.push(other);
    t.bb.storage.database().prepare("INSERT INTO worktree_cards(environment_id, stage, updated_at, owner_thread_id) VALUES ('other-env', 'tdd', 42, 'other-worker')").run();
    await t.harness.behavior.runCli(["resume", "env"]);
    expect(t.retries).toHaveLength(0);
    expect(t.requests).toHaveLength(0);
  });

  it.each(["planner", "worker"])("resumes a failed %s on the same thread across reload and concurrent reconciliation", async kind => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    if (kind === "worker") {
      await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{
        id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
        execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" },
      }] } }, { ...t.agent, threadId: t.threads[1]!.id });
      await t.harness.behavior.runSchedule("reconcile-worktrees");
    }
    const worker = t.threads.at(-1)!;
    const before = await t.context();
    worker.status = "error";
    Object.assign(worker, { hasPendingInteraction: true });
    await t.harness.behavior.runCli(["resume", "env"]);
    expect(t.retries).toHaveLength(0);
    Object.assign(worker, { hasPendingInteraction: false });
    await t.harness.behavior.runCli(["pause", "env"]);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.retries).toHaveLength(0);
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    await Promise.all([t.harness.behavior.runCli(["resume", "env"]), t.harness.behavior.runSchedule("reconcile-worktrees")]);
    expect(t.retries).toEqual([{ threadId: worker.id, turnRequestId: `${worker.id}-failed`, reason: "Resume the assigned workflow thread after a failed turn" }]);
    expect(t.requests).toHaveLength(kind === "worker" ? 2 : 1);
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, t.agent) as string);
    expect(ctx.taskRevision).toBe(before.taskRevision);
    expect(ctx.stageUpdatedAt).toBe(before.stageUpdatedAt);
    expect(ctx.ownerThreadId).toBe(before.ownerThreadId);
    expect(next.bb.storage.database().prepare("SELECT recovery_count FROM worktree_delivery_runs").get()).toEqual({ recovery_count: 0 });
    // A stale failure view cannot duplicate the failed turn, even after reload.
    const restarted = await t.harness.lifecycle.reload(plugin); t.harness = restarted.harness;
    disposals.push(() => restarted.harness.lifecycle.dispose());
    worker.status = "error";
    await t.harness.behavior.runCli(["resume", "env"]);
    expect(t.retries).toHaveLength(1);
    // Further failures stay in the same thread, within a durable retry budget.
    t.failedRequests.set(worker.id, "second-failure");
    await t.harness.behavior.runCli(["resume", "env"]);
    expect(t.retries).toHaveLength(2);
    worker.status = "error"; t.failedRequests.set(worker.id, "third-failure");
    await t.harness.behavior.runCli(["resume", "env"]);
    expect(t.retries).toHaveLength(2);
    expect(t.requests).toHaveLength(kind === "worker" ? 2 : 1);
    const health = await t.harness.behavior.runCli(["health", "project"]);
    expect(String(health.stdout)).toContain("retry-blocked");
  });

  it("shows a stale setup in health while it has no implementation launch", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, requiredChecks: [...t.task.requiredChecks, "Security CI"] }, t.agent);
    t.bb.storage.database().prepare("UPDATE worktree_setup_requests SET status = 'stale', last_error = 'Task or stage changed'").run();
    const health = await t.harness.behavior.runCli(["health", "project"]);
    expect(JSON.parse(String(health.stdout))).toEqual([expect.objectContaining({ status: "setup-stale", error: "Task or stage changed" })]);
  });

  it("converts a matching legacy stage list through the assigned setup worker without changing authority", async () => {
    const t = await setup(false, { startInDesign: true, useInitiatingThread: true });
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "design", task: t.task }, t.agent);
    const stages = ["tdd", "quality", "simplify", "pr"];
    const legacyTask = { ...(await t.context()).task, deliveryStages: stages,
      stageChecks: { tdd: ["Scope check"], quality: ["Required checks"] } };
    await t.harness.behavior.callAgentTool("treelanes_set_task", legacyTask, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent);
    const before = await t.context();
    const steps = stages.map(stage => ({ id: stage, title: stage, stage,
      instructions: "Complete the saved task", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded test assignment" } }));
    const proposal = { setup: { summary: "Complete approved stages", steps } };
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", {
      setup: { ...proposal.setup, steps: steps.filter(step => step.stage !== "simplify") },
    }, t.agent)).rejects.toThrow(/deliveryStages/i);
    expect((await t.context()).task).toEqual(before.task);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, t.agent);
    const after = await t.context();
    const { deliveryStages, ...authority } = before.task;
    expect(after.task).toEqual({ ...authority, setup: proposal.setup });
    expect(after.taskRevision).toBe(before.taskRevision + 1);
    expect(after.automaticSetup.status).toBe("applied");
    expect(after.activeStep.id).toBe("tdd");
    expect(t.requests).toHaveLength(0);
    await t.idle();
    expect(t.requests).toHaveLength(1);
    expect((await t.context()).ownerThreadId).toBe(t.threads[1]!.id);
  });

  it("automatically plans, validates, and starts an authorized task once across reload", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.prompt).toContain("treelanes_apply_setup");
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    const proposal = { setup: { summary: "One focused fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix the API bug", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: ["tdd"], reason: "Bounded API change" } }] } };
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, planner);
    expect(t.requests).toHaveLength(1);
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]).toMatchObject({ providerId: "codex", model: "small", reasoningLevel: "low" });
    const worker = { ...t.agent, threadId: t.threads[2]!.id };
    const context = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    expect(context.ownerThreadId).toBe(worker.threadId);
    expect(context.activeStep.id).toBe("fix");
  });

  it("explicitly replans twice, retains checks, and then stops", async () => {
    const t = await setup();
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    const proposal = { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } };
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, t.agent)).rejects.toThrow(/assigned/);
    for (let cycle = 0; cycle < 3; cycle++) {
      const planner = { ...t.agent, threadId: (await t.context()).automaticSetup.thread_id ?? t.threads[1]!.id };
      if (cycle > 0) {
        const dropped = structuredClone(proposal); dropped.setup.steps[0]!.checks = ["easier"];
        await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", dropped, planner)).rejects.toThrow(/retain/);
        proposal.setup.steps[0]!.execution.model = "large";
        proposal.setup.steps[0]!.execution.reasoningLevel = "high";
        proposal.setup.steps[0]!.instructions = `Address failure ${cycle}`;
      }
      await t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, planner);
      await t.harness.behavior.runSchedule("reconcile-worktrees");
      const worker = t.threads.at(-1)!;
      expect(worker.id).not.toBe(planner.threadId);
      const recover = () => t.harness.behavior.callAgentTool("treelanes_recover", { reason: "Needs a different plan", nextAction: "Use the larger model to diagnose the API" }, { ...t.agent, threadId: worker.id });
      if (cycle < 2) await recover();
      else await expect(recover()).rejects.toThrow(/limit/);
      await t.harness.behavior.runSchedule("reconcile-worktrees");
    }
    expect(t.requests).toHaveLength(4);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(4);
    expect(t.requests[2]?.model).toBe("large");
    const current = await t.context();
    expect(current.task.requiredChecks).toEqual(t.task.requiredChecks);
    expect(current.task.allowedActions).toEqual(t.task.allowedActions);
  });

  it("waits for the worker to stop and respects pause before plan recovery", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } }, planner);
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    const worker = t.threads[2]!; worker.status = "active";
    await t.harness.behavior.callAgentTool("treelanes_recover", { reason: "The regression still fails after local fixes" }, { ...t.agent, threadId: worker.id });
    await t.harness.behavior.runSchedule("reconcile-worktrees"); expect(t.requests).toHaveLength(2);
    worker.status = "idle";
    await t.harness.behavior.runCli(["pause", "env"]);
    await t.harness.behavior.runSchedule("reconcile-worktrees"); expect(t.requests).toHaveLength(2);
    t.harness.sdk.stub("threads.send", async () => ({ ok: true }));
    await t.harness.behavior.runCli(["resume", "env"]); expect(t.requests).toHaveLength(2);
    expect(t.harness.inspection.sdk.callsTo("threads.send").at(-1)?.[0]).toMatchObject({ threadId: t.threads[1]!.id });
  });

  it("adopts a live setup worker after a lost spawn response and reload", async () => {
    const t = await setup(); t.visibility.failNextSpawnAfterCreate = true;
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    t.threads[1]!.status = "active";
    const next = await t.harness.lifecycle.reload(plugin); t.harness = next.harness;
    disposals.push(() => next.harness.lifecycle.dispose());
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(1);
    const context = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, t.agent) as string);
    expect(context.automaticSetup).toMatchObject({ status: "started", thread_id: t.threads[1]!.id, attempts: 1 });
    const health = await t.harness.behavior.runCli(["health", "project"]);
    expect(JSON.parse(String(health.stdout))).toEqual([]);
  });

  it("keeps a paused proposal and an unsupported model from changing the task", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    const planner = { ...t.agent, threadId: t.threads[1]!.id };
    const proposal = { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
      execution: { providerId: "codex", model: "missing", reasoningLevel: "low", skills: [], reason: "Bounded fix" } }] } };
    const before = await t.context();
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, planner)).rejects.toThrow(/model/i);
    proposal.setup.steps[0]!.execution.model = "small";
    await t.harness.behavior.runCli(["pause", "env"]);
    await expect(t.harness.behavior.callAgentTool("treelanes_apply_setup", proposal, planner)).rejects.toThrow(/unpaused/);
    expect((await t.context()).taskRevision).toBe(before.taskRevision);
    expect(t.requests).toHaveLength(1);
    await expect(t.harness.behavior.callAgentTool("treelanes_set_task", t.task, planner)).rejects.toThrow(/cannot change/);
  });

  it("does not replan a worker error while human input is pending", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_deliver", { stage: "tdd", task: t.task }, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_apply_setup", { setup: { summary: "Fix", steps: [{ id: "fix", title: "Fix", stage: "tdd", instructions: "Fix", checks: ["API regression"],
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
    await t.harness.behavior.callAgentTool("treelanes_set_task", task, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent);
    expect(t.requests[0]).toMatchObject({ providerId: "codex", model: "small", reasoningLevel: "low" });
    expect(t.requests[0]?.prompt).toContain("execution.selectedSkills");
    expect(t.requests[0]?.prompt).not.toContain("/skills/tdd/SKILL.md");
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    expect(ctx.activeStep.id).toBe("inspect");
    expect(JSON.stringify(ctx.execution.selectedSkills)).toContain("/skills/tdd/SKILL.md");
    expect(ctx.task).toEqual({ constraints: [], decisionInputs: [], ...task });
    await t.harness.behavior.callAgentTool("treelanes_complete_stage", { ...await t.receipt(), stageUpdatedAt: ctx.stageUpdatedAt,
      checks: [{ name: "API regression", status: "passed", evidence: "3 tests pass" }, { name: "Step check", status: "passed", evidence: "Inspection passed" }] }, worker);
    const reloaded = await t.harness.lifecycle.reload(plugin);
    t.harness = reloaded.harness;
    disposals.push(() => reloaded.harness.lifecycle.dispose());
    await t.harness.behavior.runSchedule("reconcile-worktrees");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]).toMatchObject({ providerId: "claude-code", model: "large", reasoningLevel: "high" });
    const nextWorker = { ...t.agent, threadId: t.threads[2]!.id };
    const next = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, nextWorker) as string);
    expect(next.activeStep.id).toBe("implement");
    expect(next.completedStepIds).toEqual(["inspect"]);
    expect(next.stageUpdatedAt).toBeGreaterThan(ctx.stageUpdatedAt);
    await t.harness.behavior.callAgentTool("treelanes_complete_stage", { stage: next.stage, stageUpdatedAt: next.stageUpdatedAt,
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
    await t.harness.behavior.callAgentTool("treelanes_set_task", task, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent);
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const added = { ...task, setup: { summary: "Add a check after new findings", steps: [...task.setup.steps, step("check")] } };
    await t.harness.behavior.callAgentTool("treelanes_set_task", added, worker);
    expect((await t.context()).nextStep.id).toBe("check");
    await t.harness.behavior.callAgentTool("treelanes_set_task", task, worker);
    expect((await t.context()).nextStep).toBeNull();
    const changed = structuredClone(task); changed.setup.steps[0]!.execution.model = "large";
    await expect(t.harness.behavior.callAgentTool("treelanes_set_task", changed, worker)).rejects.toThrow(/already started/);
    expect(t.requests).toHaveLength(1);
  });

  it("blocks setup dispatch while paused and never substitutes an unknown model", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, setup: { summary: "Check selection", steps: [{
      id: "fix", title: "Fix", stage: "tdd", instructions: "Fix the bug", checks: ["API regression"],
      execution: { providerId: "codex", model: "missing", reasoningLevel: "low", skills: [], reason: "Explicit choice" },
    }] } }, t.agent);
    await t.harness.behavior.runCli(["pause", "env"]);
    await expect(t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent)).rejects.toThrow(/paused/);
    await t.harness.behavior.runCli(["resume", "env"]);
    await expect(t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent)).rejects.toThrow(/model/i);
    expect(t.requests).toHaveLength(0);
    const corrected = (await t.context()).task;
    corrected.setup.steps[0].execution.model = "small";
    await t.harness.behavior.callAgentTool("treelanes_set_task", corrected, t.agent);
    await t.harness.behavior.callAgentTool("treelanes_start", {}, t.agent);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.model).toBe("small");
  });

  it("stores a PR setup only after a matching merge", async () => {
    const t = await setup();
    const execution = { providerId: "codex", model: "small", reasoningLevel: "low", skills: [], reason: "Bounded work" };
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, setup: { summary: "Fix and PR", steps: [
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
    await expect(t.harness.behavior.callAgentTool("treelanes_move_card", { stage: "done" }, t.agent)).rejects.toThrow(/setup.*complete/i);
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
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, deliveryStages: ["tdd", "quality", "pr"] }, t.agent);
    await t.idle(); expect(t.stage()).toBe("tdd"); expect(t.requests).toHaveLength(0);
  });

  it("uses the task plan to skip a needless Simplify stage", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, deliveryStages: ["tdd", "quality", "pr"] }, t.agent);
    await t.submit(await t.receipt()); await t.idle();
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    expect(ctx.nextStage).toBe("pr");
    await t.harness.behavior.callAgentTool("treelanes_complete_stage", { ...await t.receipt(), stage: "quality", stageUpdatedAt: ctx.stageUpdatedAt, workspaceDigest: ctx.workspaceDigest }, worker);
    await t.harness.behavior.emitThreadEvent("thread.idle", { thread: t.threads[1]!, lastAssistantText: "Clear.\n[workflow:quality-clear]" });
    expect(t.stage()).toBe("pr");
    expect(t.requests).toHaveLength(2);
  });

  it("keeps global checks and adds checks for the current stage", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, stageChecks: { tdd: ["Type check"], quality: ["Review"] } }, t.agent);
    expect((await t.context()).requiredChecks).toEqual(["API regression", "Type check"]);
    await expect(t.submit(await t.receipt())).rejects.toThrow(/Type check/);
    const receipt = await t.receipt(); receipt.checks.push({ name: "Type check", status: "passed", evidence: "tsc: exit 0" });
    await t.submit(receipt); await t.idle(); expect(t.stage()).toBe("quality");
  });

  it("can finish the planned work without starting PR work", async () => {
    const t = await setup();
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, deliveryStages: ["tdd", "quality"] }, t.agent);
    await t.submit(await t.receipt()); await t.idle();
    const worker = { ...t.agent, threadId: t.threads[1]!.id };
    const ctx = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, worker) as string);
    expect(ctx.nextStage).toBeNull();
    await t.harness.behavior.callAgentTool("treelanes_complete_stage", { ...await t.receipt(), stage: "quality", stageUpdatedAt: ctx.stageUpdatedAt, workspaceDigest: ctx.workspaceDigest }, worker);
    await t.harness.behavior.runCli(["reconcile"]);
    expect(t.stage()).toBe("quality"); expect(t.requests).toHaveLength(1);
  });

  it.each([["tdd", "pr"], ["quality", "tdd"], ["quality", "quality"], ["review"]])("rejects an invalid delivery plan %j", async (...deliveryStages) => {
    const t = await setup();
    await expect(t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, deliveryStages }, t.agent)).rejects.toThrow();
  });

  it("reads the assigned worker even when it is hidden from the card", async () => {
    const t = await setup(); await t.submit(await t.receipt()); await t.idle();
    t.visibility.hideWorkers = true;
    const result = await t.harness.behavior.runCli(["health"]);
    expect(JSON.parse(String(result.stdout))).toEqual([expect.objectContaining({ status: "evidence-needed" })]);
  });

  it("does not let an agent bypass completion by assigning a later stage", async () => {
    const t = await setup();
    const result = await t.harness.behavior.callAgentTool("treelanes_move_card", { stage: "pr" }, t.agent);
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
    expect(t.requests[0]?.prompt!.length).toBeLessThan(1000);
    expect(t.requests[0]?.prompt).not.toContain("API regression");
    const next = JSON.parse(await t.harness.behavior.callAgentTool("treelanes_get_context", {}, { ...t.agent, threadId: t.threads.at(-1)!.id }) as string);
    expect(next.requiredChecks).toContain("API regression");
    expect(next.task.decisions).toContain("Keep the existing API");
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
    await t.harness.behavior.callAgentTool("treelanes_set_task", { ...t.task, scope: ["src/other.ts"] }, t.agent);
    expect((await t.context()).taskRevision).toBeGreaterThan(evidence.taskRevision);
    await t.idle();
    expect(t.stage()).toBe("tdd"); expect(t.requests).toHaveLength(0);
  });

  it("preserves the task revision when the saved request is unchanged", async () => {
    const t = await setup(); const before = await t.context();
    await t.harness.behavior.callAgentTool("treelanes_set_task", t.task, t.agent);
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
    await expect(t.harness.behavior.callAgentTool("treelanes_complete_stage", await t.receipt(), { ...t.agent, threadId: other.id })).rejects.toThrow(/assigned stage worker/i);
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
