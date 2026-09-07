import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

type WorktreeThread = ReturnType<typeof worktreeThread>;

function worktreeThread(
  values: Parameters<typeof makeThreadResponse>[0] & {
    environmentId?: string;
    environmentName?: string;
    environmentBranchName?: string;
  },
) {
  const environmentId = values.environmentId ?? "environment-one";
  return {
    ...makeThreadResponse({ ...values, environmentId }),
    environmentId,
    environmentName: values.environmentName ?? "board-worktree",
    environmentBranchName: values.environmentBranchName ?? "feat/board",
    environmentWorkspaceDisplayKind: "managed-worktree" as const,
  };
}

function environment(
  environmentId = "environment-one",
  projectId = "project-one",
  branchName = "feat/board",
) {
  return {
    id: environmentId,
    name: `${environmentId}-worktree`,
    projectId,
    hostId: "host-one",
    path: `/work/${environmentId}`,
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    workspaceProvisionType: "managed-worktree" as const,
    branchName,
    baseBranch: "main",
    defaultBranch: "main",
    mergeBaseBranch: "main",
    status: "ready" as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

function availablePullRequest(
  state: "open" | "closed" | "draft" | "merged" = "merged",
  headRefName = "feat/board",
) {
  return {
    outcome: "available" as const,
    pullRequest: {
      attention: state === "merged" ? "merged" : state,
      baseRefName: "main",
      checks: {
        failedCount: 0,
        passedCount: 1,
        pendingCount: 0,
        state: "passing" as const,
        totalCount: 1,
      },
      headRefName,
      mergeability: {
        mergeStateStatus: "CLEAN" as const,
        mergeable: "MERGEABLE" as const,
        state: "mergeable" as const,
      },
      number: 7,
      review: {
        reviewRequestCount: 0,
        state: "approved" as const,
      },
      state,
      title: "The change",
      updatedAt: "2026-09-05T00:00:00Z",
      url: "https://github.com/example/project/pull/7",
    },
  };
}

function sdkFor(
  threads: WorktreeThread[],
  options: {
    pullRequests?: Record<string, unknown>;
    environments?: Record<string, ReturnType<typeof environment>>;
    spawn?: (request: unknown) => unknown | Promise<unknown>;
  } = {},
) {
  return {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (!thread) throw new Error(`Unknown thread ${threadId}`);
        return thread;
      },
      list: async ({ projectId }: { projectId?: string } = {}) =>
        threads.filter(
          (thread) => projectId === undefined || thread.projectId === projectId,
        ),
      defaultExecutionOptions: async () => ({
        model: "gpt-5.6-sol",
        reasoningLevel: "high" as const,
        permissionMode: "auto" as const,
        source: "client/turn/start" as const,
      }),
      spawn: async (request: unknown) => {
        if (options.spawn) return options.spawn(request);
        return worktreeThread({
          id: "thread-stage-worker",
          projectId: "project-one",
          title: "Run the stage",
          parentThreadId: threads[0]?.id ?? null,
          status: "active",
        });
      },
      queuedMessages: {
        list: async () => [],
      },
      interactions: {
        list: async () => [],
      },
    },
    providers: {
      models: async ({ providerId }: { providerId: string }) => ({
        providers: [],
        permissionCeiling: "auto" as const,
        models: [
          {
            id: providerId === "claude-code" ? "claude-opus-4-1" : "gpt-5.6-sol",
            model: providerId === "claude-code" ? "claude-opus-4-1" : "gpt-5.6-sol",
            displayName: "Default model",
            description: "",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "high" as const,
            isDefault: true,
          },
        ],
      }),
    },
    environments: {
      get: async ({ environmentId }: { environmentId: string }) =>
        options.environments?.[environmentId] ?? environment(environmentId),
      pullRequest: async ({ environmentId }: { environmentId: string }) =>
        options.pullRequests?.[environmentId] ?? { outcome: "absent" as const },
    },
    projects: {
      list: async () => [
        { id: "project-one", name: "Test project" },
        { id: "project-two", name: "Second project" },
      ],
    },
    plugins: {
      callRpc: async () => ({ rows: [] }),
    },
  };
}

function seedWorktreeState(
  bb: BbPluginApi,
  values: {
    environmentId: string;
    stage: string;
    stageUpdatedAt: number;
    ownerThreadId?: string | null;
  },
) {
  bb.storage
    .database()
    .prepare(
      `INSERT INTO worktree_cards
        (environment_id, stage, note, updated_at, owner_thread_id)
       VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(
      values.environmentId,
      values.stage,
      values.stageUpdatedAt,
      values.ownerThreadId ?? null,
    );
}

function seedLaunch(
  bb: BbPluginApi,
  values: {
    environmentId: string;
    stage: string;
    stageUpdatedAt: number;
    status: "pending" | "starting" | "started" | "failed" | "blocked" | "paused";
    threadId?: string | null;
    attemptCount?: number;
    updatedAt?: number;
    nextAttemptAt?: number;
    lastError?: string | null;
  },
) {
  bb.storage
    .database()
    .prepare(
      `INSERT INTO worktree_stage_thread_launches
        (environment_id, stage, stage_updated_at, status, thread_id,
         attempt_count, updated_at, next_attempt_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.environmentId,
      values.stage,
      values.stageUpdatedAt,
      values.status,
      values.threadId ?? null,
      values.attemptCount ?? 0,
      values.updatedAt ?? 0,
      values.nextAttemptAt ?? 0,
      values.lastError ?? null,
    );
}

describe("Workflow Board reliability", () => {
  it.each([
    {
      reason: "no pull request",
      pullRequest: { outcome: "absent" as const },
    },
    {
      reason: "an unavailable pull request",
      pullRequest: {
        outcome: "unavailable" as const,
        message: "Git host is unavailable",
      },
    },
    {
      reason: "an open pull request",
      pullRequest: availablePullRequest("open"),
    },
    {
      reason: "a merged pull request for another branch",
      pullRequest: availablePullRequest("merged", "feat/other"),
    },
  ])("rejects Done with $reason", async ({ pullRequest }) => {
    const worktree = worktreeThread({
      id: "thread-done-gate",
      projectId: "project-one",
      title: "Verify the pull request",
      parentThreadId: null,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor([worktree], {
        pullRequests: { [worktree.environmentId]: pullRequest },
      }),
    });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("moveCard", {
        environmentId: worktree.environmentId,
        stage: "done",
      }),
    ).rejects.toThrow(/verified merged pull request/i);
    expect(harness.sdk.callsTo("environments.pullRequest")).toHaveLength(1);

    await harness.lifecycle.dispose();
  });

  it("accepts Done only for a merged pull request on the environment branch", async () => {
    const worktree = worktreeThread({
      id: "thread-done-accepted",
      projectId: "project-one",
      title: "Merged change",
      parentThreadId: null,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor([worktree], {
        pullRequests: {
          [worktree.environmentId]: availablePullRequest("merged", "feat/board"),
        },
      }),
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("moveCard", {
      environmentId: worktree.environmentId,
      stage: "done",
    });
    expect(result).toEqual({
      environmentId: worktree.environmentId,
      stage: "done",
    });
    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: worktree.projectId,
    })) as { cards: Array<{ stage: string }> };
    expect(board.cards[0]?.stage).toBe("done");

    await harness.lifecycle.dispose();
  });

  it("does not let an unrelated TDD thread advance the Worktree Stage", async () => {
    const root = worktreeThread({
      id: "thread-tdd-root",
      projectId: "project-one",
      title: "Build the change",
      parentThreadId: null,
      updatedAt: 100,
    });
    const unrelated = worktreeThread({
      id: "thread-tdd-unrelated",
      projectId: "project-one",
      title: "Unrelated TDD work",
      parentThreadId: root.id,
      updatedAt: 200,
    });
    const threads = [root, unrelated];
    const spawned: WorktreeThread[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor(threads, {
        spawn: async () => {
          const worker = worktreeThread({
            id: "thread-tdd-worker",
            projectId: "project-one",
            title: "Run TDD",
            parentThreadId: root.id,
            status: "active",
          });
          threads.push(worker);
          spawned.push(worker);
          return worker;
        },
      }),
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "design",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "tdd",
    });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: unrelated,
      lastAssistantText: "TDD complete.\n[workflow:tdd-complete]",
    });

    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: root.projectId,
    })) as { cards: Array<{ stage: string }> };
    expect(board.cards[0]?.stage).toBe("tdd");
    expect(spawned).toHaveLength(1);

    await harness.lifecycle.dispose();
  });

  it("does not chain a Code Review completion marker", async () => {
    const review = worktreeThread({
      id: "thread-code-review-reliability",
      projectId: "project-one",
      title: "Review external changes",
      parentThreadId: null,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor([review]),
    });
    await plugin(bb);

    const message = await harness.behavior.callAgentTool(
      "workflow_board_move_card",
      { stage: "review", note: "External review only." },
      { threadId: review.id, projectId: review.projectId },
    );
    expect(message).toContain("Code Review");
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: review,
      lastAssistantText: "No findings remain.\n[workflow:quality-clear]",
    });

    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: review.projectId,
    })) as { cards: Array<{ stage: string }> };
    expect(board.cards[0]?.stage).toBe("review");
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("keeps a failed stage launch for health and retries it on the same-stage panel action", async () => {
    const root = worktreeThread({
      id: "thread-failed-launch",
      projectId: "project-one",
      title: "Recover the stage worker",
      parentThreadId: null,
    });
    const threads = [root];
    let spawnAttempts = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor(threads, {
        spawn: async () => {
          spawnAttempts += 1;
          if (spawnAttempts === 1) throw new Error("first spawn failed");
          const worker = worktreeThread({
            id: "thread-recovered-worker",
            projectId: "project-one",
            title: "Recovered TDD",
            parentThreadId: root.id,
            status: "active",
          });
          threads.push(worker);
          return worker;
        },
      }),
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "design",
    });
    await expect(
      harness.behavior.callRpc("moveCard", {
        environmentId: root.environmentId,
        stage: "tdd",
      }),
    ).rejects.toThrow("first spawn failed");

    const health = await harness.behavior.runCli(["health", root.projectId]);
    expect(health.exitCode).toBe(0);
    expect(health.stdout).toContain("failed");
    expect(health.stdout).toContain("first spawn failed");
    expect(spawnAttempts).toBe(1);

    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "tdd",
    });
    expect(spawnAttempts).toBe(2);

    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "tdd",
    });
    expect(spawnAttempts).toBe(2);

    await harness.lifecycle.dispose();
  });

  it("blocks a launch after three failed attempts", async () => {
    const root = worktreeThread({
      id: "thread-retry-budget",
      projectId: "project-one",
      title: "Exhaust the retry budget",
      parentThreadId: null,
    });
    let spawnAttempts = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor([root], {
        spawn: async () => {
          spawnAttempts += 1;
          throw new Error("third attempt failed");
        },
      }),
    });
    await plugin(bb);

    const stageUpdatedAt = 42;
    seedWorktreeState(bb, {
      environmentId: root.environmentId,
      stage: "tdd",
      stageUpdatedAt,
    });
    seedLaunch(bb, {
      environmentId: root.environmentId,
      stage: "tdd",
      stageUpdatedAt,
      status: "failed",
      attemptCount: 2,
      updatedAt: Date.now() - 60_000,
      nextAttemptAt: 0,
      lastError: "retry 2 failed",
    });

    await expect(
      harness.behavior.callRpc("moveCard", {
        environmentId: root.environmentId,
        stage: "tdd",
      }),
    ).rejects.toThrow("third attempt failed");

    const health = await harness.behavior.runCli(["health", root.projectId]);
    const rows = JSON.parse(String(health.stdout)) as Array<{
      status: string;
      attempts: number;
      error: string | null;
    }>;
    expect(rows[0]).toMatchObject({
      status: "blocked",
      attempts: 3,
      error: "third attempt failed",
    });

    await harness.behavior
      .callRpc("moveCard", {
        environmentId: root.environmentId,
        stage: "tdd",
      })
      .catch(() => undefined);
    expect(spawnAttempts).toBe(1);

    await harness.lifecycle.dispose();
  });

  it("lets reconcile retry a failed launch through the CLI", async () => {
    const root = worktreeThread({
      id: "thread-cli-reconcile",
      projectId: "project-one",
      title: "Retry from the CLI",
      parentThreadId: null,
    });
    const threads = [root];
    let spawnAttempts = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor(threads, {
        spawn: async () => {
          spawnAttempts += 1;
          if (spawnAttempts === 1) throw new Error("temporary provider failure");
          const worker = worktreeThread({
            id: "thread-cli-recovered",
            projectId: "project-one",
            title: "CLI recovered worker",
            parentThreadId: root.id,
            status: "active",
          });
          threads.push(worker);
          return worker;
        },
      }),
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "design",
    });
    await expect(
      harness.behavior.callRpc("moveCard", {
        environmentId: root.environmentId,
        stage: "tdd",
      }),
    ).rejects.toThrow("temporary provider failure");

    const result = await harness.behavior.runCli(["reconcile"]);
    expect(result.exitCode).toBe(0);
    expect(spawnAttempts).toBe(2);

    const second = await harness.behavior.runCli(["reconcile"]);
    expect(second.exitCode).toBe(0);
    expect(spawnAttempts).toBe(2);

    await harness.lifecycle.dispose();
  });

  it("starts one worker when two panel retries race", async () => {
    const root = worktreeThread({
      id: "thread-concurrent-retry",
      projectId: "project-one",
      title: "Retry once",
      parentThreadId: null,
    });
    const threads = [root];
    let spawnAttempts = 0;
    let releaseSecondSpawn!: () => void;
    let markSecondSpawnStarted!: () => void;
    const secondSpawnStarted = new Promise<void>((resolve) => {
      markSecondSpawnStarted = resolve;
    });
    const secondSpawnGate = new Promise<void>((resolve) => {
      releaseSecondSpawn = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor(threads, {
        spawn: async () => {
          spawnAttempts += 1;
          if (spawnAttempts === 1) throw new Error("initial worker failed");
          const worker = worktreeThread({
            id: "thread-concurrent-worker",
            projectId: "project-one",
            title: "Concurrent worker",
            parentThreadId: root.id,
            status: "active",
          });
          threads.push(worker);
          markSecondSpawnStarted();
          await secondSpawnGate;
          return worker;
        },
      }),
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "design",
    });
    await expect(
      harness.behavior.callRpc("moveCard", {
        environmentId: root.environmentId,
        stage: "tdd",
      }),
    ).rejects.toThrow("initial worker failed");

    const firstRetry = harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "tdd",
    });
    const secondRetry = harness.behavior.callRpc("moveCard", {
      environmentId: root.environmentId,
      stage: "tdd",
    });
    const secondSpawnObserved = await Promise.race([
      secondSpawnStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseSecondSpawn();
    await Promise.race([
      Promise.allSettled([firstRetry, secondRetry]),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    expect(secondSpawnObserved).toBe(true);
    expect(spawnAttempts).toBe(2);

    await harness.lifecycle.dispose();
  });

  it("reconciles stale pending and starting rows at startup and on schedule", async () => {
    const pending = worktreeThread({
      id: "thread-recovery-pending",
      projectId: "project-one",
      title: "Pending recovery",
      parentThreadId: null,
      environmentId: "environment-pending",
      environmentName: "pending-worktree",
      environmentBranchName: "feat/pending",
    });
    const starting = worktreeThread({
      id: "thread-recovery-starting",
      projectId: "project-one",
      title: "Starting recovery",
      parentThreadId: null,
      environmentId: "environment-starting",
      environmentName: "starting-worktree",
      environmentBranchName: "feat/starting",
    });
    const liveRoot = worktreeThread({
      id: "thread-recovery-live-root",
      projectId: "project-one",
      title: "Live work",
      parentThreadId: null,
      environmentId: "environment-live",
      environmentName: "live-worktree",
      environmentBranchName: "feat/live",
    });
    const liveWorker = worktreeThread({
      id: "thread-recovery-live-worker",
      projectId: "project-one",
      title: "Live worker",
      parentThreadId: liveRoot.id,
      environmentId: "environment-live",
      environmentName: "live-worktree",
      environmentBranchName: "feat/live",
      status: "active",
    });
    const paused = worktreeThread({
      id: "thread-recovery-paused",
      projectId: "project-one",
      title: "Paused work",
      parentThreadId: null,
      environmentId: "environment-paused",
      environmentName: "paused-worktree",
      environmentBranchName: "feat/paused",
    });
    const orphanRoot = worktreeThread({
      id: "thread-recovery-orphan-root",
      projectId: "project-one",
      title: "Orphan recovery",
      parentThreadId: null,
      environmentId: "environment-orphan",
      environmentName: "orphan-worktree",
      environmentBranchName: "feat/orphan",
    });
    const orphanWorker = worktreeThread({
      id: "thread-recovery-orphan-worker",
      projectId: "project-one",
      title: "Workflow TDD [environment-orphan:tdd:14]",
      parentThreadId: orphanRoot.id,
      environmentId: "environment-orphan",
      environmentName: "orphan-worktree",
      environmentBranchName: "feat/orphan",
      status: "active",
    });
    const threads = [
      pending,
      starting,
      liveRoot,
      liveWorker,
      paused,
      orphanRoot,
      orphanWorker,
    ];
    const spawned: WorktreeThread[] = [];
    const environments = {
      "environment-pending": environment("environment-pending", "project-one", "feat/pending"),
      "environment-starting": environment("environment-starting", "project-one", "feat/starting"),
      "environment-live": environment("environment-live", "project-one", "feat/live"),
      "environment-paused": environment("environment-paused", "project-one", "feat/paused"),
      "environment-orphan": environment("environment-orphan", "project-one", "feat/orphan"),
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflow-board",
      sdk: sdkFor(threads, {
        environments,
        spawn: async (request: unknown) => {
          const environmentId = (request as { environment?: { environmentId?: string } })
            .environment?.environmentId;
          const worker = worktreeThread({
            id: `thread-recovered-${spawned.length + 1}`,
            projectId: "project-one",
            title: "Recovered worker",
            parentThreadId: null,
            environmentId,
            status: "active",
          });
          spawned.push(worker);
          threads.push(worker);
          return worker;
        },
      }),
    });
    await plugin(bb);

    const staleAt = 10;
    seedWorktreeState(bb, {
      environmentId: "environment-pending",
      stage: "tdd",
      stageUpdatedAt: staleAt,
    });
    seedLaunch(bb, {
      environmentId: "environment-pending",
      stage: "tdd",
      stageUpdatedAt: staleAt,
      status: "pending",
      nextAttemptAt: 0,
    });
    seedWorktreeState(bb, {
      environmentId: "environment-starting",
      stage: "tdd",
      stageUpdatedAt: staleAt + 1,
    });
    seedLaunch(bb, {
      environmentId: "environment-starting",
      stage: "tdd",
      stageUpdatedAt: staleAt + 1,
      status: "starting",
      attemptCount: 1,
      updatedAt: 0,
      nextAttemptAt: 0,
    });
    seedWorktreeState(bb, {
      environmentId: "environment-live",
      stage: "tdd",
      stageUpdatedAt: staleAt + 2,
    });
    seedLaunch(bb, {
      environmentId: "environment-live",
      stage: "tdd",
      stageUpdatedAt: staleAt + 2,
      status: "pending",
      nextAttemptAt: 0,
    });
    seedWorktreeState(bb, {
      environmentId: "environment-paused",
      stage: "tdd",
      stageUpdatedAt: staleAt + 3,
    });
    seedLaunch(bb, {
      environmentId: "environment-paused",
      stage: "tdd",
      stageUpdatedAt: staleAt + 3,
      status: "pending",
      nextAttemptAt: 0,
    });
    seedWorktreeState(bb, {
      environmentId: "environment-orphan",
      stage: "tdd",
      stageUpdatedAt: staleAt + 4,
    });
    seedLaunch(bb, {
      environmentId: "environment-orphan",
      stage: "tdd",
      stageUpdatedAt: staleAt + 4,
      status: "failed",
      attemptCount: 1,
      updatedAt: 0,
      nextAttemptAt: 0,
      lastError: "spawn transport failed after worker creation",
    });
    bb.storage
      .database()
      .prepare(
        `INSERT INTO worktree_controls (environment_id, paused)
         VALUES (?, 1)`,
      )
      .run("environment-paused");

    expect(harness.registrations.services.map((service) => service.name)).toContain(
      "workflow-recovery",
    );
    expect(harness.registrations.schedules.map((schedule) => schedule.name)).toContain(
      "reconcile-worktrees",
    );

    const service = harness.behavior.runService("workflow-recovery");
    await service.done;
    expect(spawned).toHaveLength(2);
    expect(spawned.map((worker) => worker.environmentId).sort()).toEqual([
      "environment-pending",
      "environment-starting",
    ]);

    const health = await harness.behavior.runCli(["health", "project-one"]);
    expect(JSON.parse(String(health.stdout))).not.toContainEqual(
      expect.objectContaining({ environmentId: "environment-orphan" }),
    );
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-orphan",
      stage: "tdd",
    });
    expect(spawned).toHaveLength(2);

    await harness.behavior.runSchedule("reconcile-worktrees");
    expect(spawned).toHaveLength(2);

    await harness.lifecycle.dispose();
  });
});
