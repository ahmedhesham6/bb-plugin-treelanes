import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { makeWorkspaceSdk, shippedSkills } from "./test-workspace";
import { automatedNextStage, reportsFinishedGrilling } from "./workflow";

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
    activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeGoalCount: 0 },
  };
}

function environment(environmentId = "environment-one") {
  return {
    id: environmentId,
    name: "board-worktree",
    projectId: "project-one",
    hostId: "host-one",
    path: "/work/board-worktree",
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    workspaceProvisionType: "managed-worktree" as const,
    branchName: "feat/board",
    baseBranch: "main",
    defaultBranch: "main",
    mergeBaseBranch: "main",
    status: "ready" as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

function sdkFor(threads: ReturnType<typeof worktreeThread>[]) {
  const snapshot = makeWorkspaceSdk({
    files: { "src/file.ts": { content: "new" } },
  });

  return {
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        threads.find((thread) => thread.id === threadId)!,
      list: async () => threads,
      interactions: {
        list: async () => [],
      },
      queuedMessages: {
        list: async () => [],
      },
      defaultExecutionOptions: async () => ({
        model: "gpt-5.6-sol",
        reasoningLevel: "high" as const,
        permissionMode: "auto" as const,
        source: "client/turn/start" as const,
      }),
      spawn: async () => ({
        ...threads[0],
        id: "thread-started-by-stage-transition",
      }),
    },
    providers: {
      models: async ({ providerId }: { providerId: string }) => ({
        providers: [],
        permissionCeiling: "auto" as const,
        models: [
          {
            id:
              providerId === "claude-code"
                ? "claude-opus-4-1"
                : "gpt-5.6-sol",
            model:
              providerId === "claude-code"
                ? "claude-opus-4-1"
                : "gpt-5.6-sol",
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
      ...snapshot.sdk.environments,
      get: async ({ environmentId }: { environmentId: string }) =>
        ({
          ...environment(environmentId),
          hostId: "remote-host",
          path: "/srv/worktree",
          branchName: "feature/review",
          mergeBaseBranch: "main",
        }),
    },
    files: snapshot.sdk.files,
    projects: {
      list: async () => [{ id: "project-one", name: "Test project" }],
    },
  };
}

type CompletionStage = "design" | "tdd" | "quality" | "simplify";

type CompletionContext = {
  stage: CompletionStage;
  stageUpdatedAt: number;
  taskRevision: number;
  workspaceDigest: string;
};

type TestHarness = ReturnType<typeof createFakePluginHost>["harness"];

async function recordStageCompletion(
  harness: TestHarness,
  thread: ReturnType<typeof worktreeThread>,
): Promise<void> {
  const contextText = await harness.behavior.callAgentTool(
    "treelanes_get_context",
    {},
    { threadId: thread.id, projectId: thread.projectId },
  );
  const context = JSON.parse(String(contextText)) as CompletionContext;
  await harness.behavior.callAgentTool(
    "treelanes_complete_stage",
    {
      stage: context.stage,
      stageUpdatedAt: context.stageUpdatedAt,
      taskRevision: context.taskRevision,
      workspaceDigest: context.workspaceDigest,
      checks: [
        { name: "tests", status: "passed", evidence: "npm test: passed" },
      ],
      decisionsResolved: true,
      openFindings: [],
      summary: "Stage completed with checks.",
    },
    { threadId: thread.id, projectId: thread.projectId },
  );
}

async function emitStageCompletion(
  harness: TestHarness,
  thread: ReturnType<typeof worktreeThread>,
  marker: string,
): Promise<void> {
  await recordStageCompletion(harness, thread);
  thread.status = "idle";
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: `Verified.\n${marker}`,
  });
}

describe("Board backend", () => {
  it("starts configured TDD work in the same Git Worktree", async () => {
    const design = worktreeThread({
      id: "thread-design",
      projectId: "project-one",
      title: "Design the change",
      parentThreadId: null,
    });
    design.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([design]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6-sol",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
            source: "client/turn/start" as const,
          }),
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-tdd",
              projectId: "project-one",
              title: "Implement the design",
              parentThreadId: design.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "design",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "tdd",
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "project-one",
      providerId: "codex",
      model: "gpt-5.6-sol",
      parentThreadId: design.id,
      environment: {
        type: "reuse",
        environmentId: "environment-one",
      },
      prompt: expect.stringContaining(
        "Use the tdd skill.\nImplement the saved step through the accepted test interfaces.",
      ),
    });

    await harness.lifecycle.dispose();
  });

  it("starts configured Quality work after TDD", async () => {
    const tdd = worktreeThread({
      id: "thread-tdd",
      projectId: "project-one",
      title: "Implement the design",
      parentThreadId: null,
    });
    tdd.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([tdd]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6-sol",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
            source: "client/turn/start" as const,
          }),
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-quality",
              projectId: "project-one",
              title: "Review the changes",
              parentThreadId: tdd.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "tdd",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "quality",
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6-sol",
      environment: { type: "reuse", environmentId: "environment-one" },
      prompt: expect.stringContaining(
        "Use the thermo-nuclear-code-quality-review skill.\nReview the task diff and fix valid findings within scope.",
      ),
    });
    await harness.lifecycle.dispose();
  });

  it("starts Simplify with the worktree thread's model and stage skill", async () => {
    const quality = worktreeThread({
      id: "thread-quality",
      projectId: "project-one",
      title: "Review the changes",
      parentThreadId: null,
    });
    quality.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([quality]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        providers: {
          models: async () => ({
            providers: [],
            permissionCeiling: "auto" as const,
            models: [
              {
                id: "claude-fable-5-1",
                model: "claude-fable-5-1",
                displayName: "Fable 5",
                description: "",
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "high" as const,
                isDefault: true,
              },
            ],
          }),
        },
        threads: {
          ...sdk.threads,
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6-sol",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
            source: "client/turn/start" as const,
          }),
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-simplify",
              projectId: "project-one",
              title: "Simplify the changes",
              parentThreadId: quality.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "quality",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "simplify",
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6-sol",
      environment: { type: "reuse", environmentId: "environment-one" },
      prompt: expect.stringContaining(
        "Use the simplify skill.\nReduce needless code in the task diff and preserve behavior.",
      ),
    });
    await harness.lifecycle.dispose();
  });

  it.each([
    { sourceStage: "tdd" as const, workerStage: "quality" as const },
    { sourceStage: "quality" as const, workerStage: "simplify" as const },
  ])(
    "rejects panel re-entry while the $workerStage worker is live",
    async ({ sourceStage, workerStage }) => {
      const main = worktreeThread({
        id: `thread-${sourceStage}`,
        projectId: "project-one",
        title: `Run ${sourceStage}`,
        parentThreadId: null,
      });
      main.providerId = "codex";
      const threads = [main];
      const spawned: unknown[] = [];
      const sdk = sdkFor(threads);
      const { bb, harness } = createFakePluginHost({
        pluginId: "treelanes",
        sdk: {
          ...sdk,
          threads: {
            ...sdk.threads,
            spawn: async (request: unknown) => {
              spawned.push(request);
              const worker = worktreeThread({
                id: `thread-${workerStage}`,
                projectId: "project-one",
                title: `Run ${workerStage}`,
                parentThreadId: main.id,
                status: "active",
              });
              worker.providerId = workerStage === "simplify" ? "claude-code" : "codex";
              threads.push(worker);
              return worker;
            },
          },
        },
      });
      await plugin(bb);

      await harness.behavior.callRpc("moveCard", {
        environmentId: "environment-one",
        stage: sourceStage,
      });
      await harness.behavior.callRpc("moveCard", {
        environmentId: "environment-one",
        stage: workerStage,
      });
      await expect(
        harness.behavior.callRpc("moveCard", {
          environmentId: "environment-one",
          stage: sourceStage,
        }),
      ).rejects.toThrow("A stage worker is still running");

      expect(spawned).toHaveLength(1);
      const board = (await harness.behavior.callRpc("getBoard", {
        projectId: main.projectId,
      })) as { cards: Array<{ stage: string }> };
      expect(board.cards[0]?.stage).toBe(workerStage);
      await harness.lifecycle.dispose();
    },
  );

  it("starts each stage thread under the main thread", async () => {
    const main = worktreeThread({
      id: "thread-main",
      projectId: "project-one",
      title: "Main work thread",
      parentThreadId: null,
      updatedAt: 100,
    });
    const quality = worktreeThread({
      id: "thread-quality",
      projectId: "project-one",
      title: "Review the changes",
      parentThreadId: main.id,
      updatedAt: 200,
    });
    quality.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([main, quality]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-simplify",
              projectId: "project-one",
              title: "Simplify the changes",
              parentThreadId: main.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "quality",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "simplify",
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ parentThreadId: main.id });

    await harness.lifecycle.dispose();
  });

  it("offers a configured PR thread after Simplify in Ask mode", async () => {
    const simplify = worktreeThread({
      id: "thread-simplify",
      projectId: "project-one",
      title: "Simplify the changes",
      parentThreadId: null,
    });
    simplify.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([simplify]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      settings: {
        simplifyToPrMode: "ask",
        prPrompt:
          "Create and watch this pull request. If a required check cannot pass, stop and report the blocker without opening a pull request.",
      },
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6-sol",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
            source: "client/turn/start" as const,
          }),
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-pr",
              projectId: "project-one",
              title: "Create and watch the PR",
              parentThreadId: simplify.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "simplify",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "pr",
    });
    const board = await harness.behavior.callRpc("getBoard", {
      projectId: "project-one",
    });

    expect(spawned).toHaveLength(0);
    expect(board.cards[0]?.pendingThreadStart).toEqual({
      stage: "pr",
      label: "Start PR thread",
    });

    const result = await harness.behavior.callRpc("startStageThread", {
      environmentId: "environment-one",
    });
    expect(result).toEqual({ threadId: "thread-pr" });
    expect(spawned[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6-sol",
      prompt: expect.stringContaining(
        "Create and watch this pull request.",
      ),
      environment: { type: "reuse", environmentId: "environment-one" },
    });
    await harness.lifecycle.dispose();
  });

  it("starts one PR Watch thread by default", async () => {
    const simplify = worktreeThread({
      id: "thread-simplify-auto",
      projectId: "project-one",
      title: "Simplify the changes",
      parentThreadId: null,
    });
    simplify.providerId = "claude-code";
    const spawned: unknown[] = [];
    const sdk = sdkFor([simplify]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          defaultExecutionOptions: async () => ({
            model: "claude-opus-4-1",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
            source: "client/turn/start" as const,
          }),
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-pr-auto",
              projectId: "project-one",
              title: "Create and watch the PR",
              parentThreadId: simplify.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "simplify",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "pr",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "pr",
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-4-1",
      prompt: expect.stringContaining(
        "/babysit-pr",
      ),
      environment: { type: "reuse", environmentId: "environment-one" },
    });
    await harness.lifecycle.dispose();
  });

  it("uses the latest Worktree thread execution settings for the composer", async () => {
    const thread = worktreeThread({
      id: "thread-claude",
      projectId: "project-one",
      title: "Claude work",
      parentThreadId: null,
    });
    thread.providerId = "claude-code";
    const sdk = sdkFor([thread]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          defaultExecutionOptions: async () => ({
            model: "claude-opus-4-1",
            serviceTier: "default" as const,
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
            source: "client/turn/start" as const,
          }),
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("getComposerDefaults", {
      threadId: thread.id,
    });

    expect(result).toEqual({
      providerId: "claude-code",
      model: "claude-opus-4-1",
      serviceTier: "default",
      reasoningLevel: "high",
      permissionMode: "auto",
    });
    await harness.lifecycle.dispose();
  });

  it("creates a thread from the host composer request", async () => {
    const request = {
      projectId: "project-one",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium" as const,
      permissionMode: "auto" as const,
      executionInputSources: {},
      environment: {
        type: "reuse" as const,
        environmentId: "environment-one",
      },
      input: [{ type: "text" as const, text: "Review this worktree", mentions: [] }],
    };
    let spawned: unknown;
    const sdk = sdkFor([]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async (value: unknown) => {
            spawned = value;
            return makeThreadResponse({
              id: "thread-new",
              projectId: "project-one",
              title: "Review this worktree",
              parentThreadId: null,
            });
          },
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("createThread", { request });

    expect(spawned).toEqual({
      ...request,
      origin: "plugin",
      originPluginId: "treelanes",
    });
    expect(result).toEqual({ threadId: "thread-new" });
    await harness.lifecycle.dispose();
  });

  it("groups unsettled root and child threads into one worktree card", async () => {
    const root = worktreeThread({
      id: "thread-root",
      projectId: "project-one",
      title: "Build the board",
      parentThreadId: null,
    });
    const child = worktreeThread({
      id: "thread-review",
      projectId: "project-one",
      title: "Run strict review",
      parentThreadId: root.id,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: sdkFor([root, child]),
    });
    await plugin(bb);

    const message = await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "quality", note: "Review pass 2" },
      { threadId: child.id, projectId: root.projectId },
    );
    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: root.projectId,
    })) as {
      cards: Array<{
        environmentId: string;
        stage: string;
        note: string | null;
        threads: Array<{ id: string }>;
      }>;
    };

    expect(message).toContain("board-worktree");
    expect(board.cards).toMatchObject([
      {
        environmentId: "environment-one",
        stage: "quality",
        note: "Review pass 2",
      },
    ]);
    expect(board.cards[0]?.threads.map((thread) => thread.id).sort()).toEqual(
      [root.id, child.id].sort(),
    );
    expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({
      channel: "board-changed",
      payload: { environmentId: "environment-one", stage: "quality" },
    });

    await harness.lifecycle.dispose();
  });

  it("keeps Design when an agent tries to start TDD before Design finishes", async () => {
    const thread = worktreeThread({
      id: "thread-babysit-pr",
      projectId: "project-one",
      title: "Babysit the PR",
      parentThreadId: null,
    });
    const spawned: unknown[] = [];
    const sdk = sdkFor([thread]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async (request: unknown) => {
            spawned.push(request);
            return thread;
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "design",
    });
    const result = await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "tdd", note: "I plan to start implementation." },
      { threadId: thread.id, projectId: thread.projectId },
    );

    const board = await harness.behavior.callRpc("getBoard", {
      projectId: thread.projectId,
    });
    expect(board.cards[0]).toMatchObject({
      stage: "design",
    });
    expect(result).toContain("Design is not finished");
    expect(spawned).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("starts Quality when a manually started TDD thread reports completion", async () => {
    const tdd = worktreeThread({
      id: "thread-manual-tdd",
      projectId: "project-one",
      title: "Implement more work with TDD",
      parentThreadId: null,
    });
    tdd.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([tdd]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-quality-after-manual-tdd",
              projectId: "project-one",
              title: "Review the changes",
              parentThreadId: tdd.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "tdd", note: "Running /tdd in this thread." },
      { threadId: tdd.id, projectId: tdd.projectId },
    );
    await recordStageCompletion(harness, tdd);
    tdd.status = "idle";
    const completion = {
      thread: tdd,
      lastAssistantText: "Implementation is complete.\n[workflow:tdd-complete]",
    };
    await harness.behavior.emitThreadEvent("thread.idle", completion);
    await harness.behavior.emitThreadEvent("thread.idle", completion);

    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: tdd.projectId,
    })) as { cards: Array<{ stage: string }> };
    expect(board.cards[0]?.stage).toBe("quality");
    expect(spawned).toHaveLength(1);

    await harness.lifecycle.dispose();
  });

  it("starts Quality once as soon as an agent assigns Quality", async () => {
    const main = worktreeThread({
      id: "thread-main",
      projectId: "project-one",
      title: "Design the change",
      parentThreadId: null,
    });
    main.providerId = "codex";
    const threads = [main];
    const spawned: unknown[] = [];
    const sdk = sdkFor(threads);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async (request: unknown) => {
            spawned.push(request);
            const thread = worktreeThread({
              id: spawned.length === 1 ? "thread-tdd" : "thread-quality",
              projectId: "project-one",
              title:
                spawned.length === 1
                  ? "Implement the design"
                  : "Review the changes",
              parentThreadId: main.id,
            });
            thread.providerId = "codex";
            threads.push(thread);
            return thread;
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "design",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "tdd",
    });
    const tdd = threads.find((thread) => thread.id === "thread-tdd");
    if (!tdd) throw new Error("The board did not start the TDD thread.");
    await recordStageCompletion(harness, tdd);
    tdd.status = "idle";
    await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "quality", note: "TDD work is complete." },
      { threadId: tdd.id, projectId: tdd.projectId },
    );

    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6-sol",
      environment: { type: "reuse", environmentId: "environment-one" },
      prompt: expect.stringContaining(
        "Use the thermo-nuclear-code-quality-review skill.\nReview the task diff and fix valid findings within scope.",
      ),
    });

    const completion = {
      thread: tdd,
      lastAssistantText: "All checks pass.\n[workflow:tdd-complete]",
    };
    await harness.behavior.emitThreadEvent("thread.idle", completion);
    await harness.behavior.emitThreadEvent("thread.idle", completion);

    expect(spawned).toHaveLength(2);

    await harness.lifecycle.dispose();
  });

  it("ignores a stale parent stage move while the Quality worker is running", async () => {
    const main = worktreeThread({
      id: "thread-main-stale-summary",
      projectId: "project-one",
      title: "Main implementation thread",
      parentThreadId: null,
    });
    main.providerId = "codex";
    const threads = [main];
    const spawned: ReturnType<typeof worktreeThread>[] = [];
    const sdk = sdkFor(threads);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async () => {
            const stage = spawned.length === 0 ? "quality" : "simplify";
            const worker = worktreeThread({
              id: `thread-${stage}-after-stale-summary`,
              projectId: "project-one",
              title: `Run ${stage}`,
              parentThreadId: main.id,
              status: "active",
            });
            worker.providerId = stage === "simplify" ? "claude-code" : "codex";
            spawned.push(worker);
            threads.push(worker);
            return worker;
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "tdd",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "quality",
    });
    const quality = spawned[0]!;
    const staleMove = await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "tdd", note: "Late TDD child summary." },
      { threadId: main.id, projectId: main.projectId },
    );
    await recordStageCompletion(harness, quality);
    quality.status = "idle";
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: quality,
      lastAssistantText: "No findings remain.\n[workflow:quality-clear]",
    });

    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: main.projectId,
    })) as { cards: Array<{ stage: string }> };
    expect(staleMove).toContain("Quality Loop worker is still running");
    expect(board.cards[0]?.stage).toBe("simplify");
    expect(spawned).toHaveLength(2);

    await harness.lifecycle.dispose();
  });

  it("places an external code review outside Implementation without chaining", async () => {
    const review = worktreeThread({
      id: "thread-code-review",
      projectId: "project-one",
      title: "Review the changes",
      parentThreadId: null,
    });
    review.providerId = "codex";
    const spawned: unknown[] = [];
    const sdk = sdkFor([review]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async (request: unknown) => {
            spawned.push(request);
            return worktreeThread({
              id: "thread-simplify",
              projectId: "project-one",
              title: "Simplify the changes",
              parentThreadId: review.id,
            });
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "review", note: "External review only. No code changes." },
      { threadId: review.id, projectId: review.projectId },
    );
    review.status = "idle";
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: review,
      lastAssistantText: "No findings remain.\n[workflow:quality-clear]",
    });

    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: review.projectId,
    })) as { cards: Array<{ stage: string }> };
    expect(board.cards[0]?.stage).toBe("review");
    expect(spawned).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("maps /code-review to Code Review in agent instructions", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      agentSkillIds: shippedSkills,
    });
    await plugin(bb);

    const configuration = await harness.behavior.resolveAgentConfiguration({
      thread: {
        id: "thread-code-review",
        title: "Review external changes",
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: "project-one",
        kind: "standard",
        name: "Test project",
        gitRemoteUrl: null,
      },
      environment: {
        id: "environment-one",
        name: "board-worktree",
        path: "/work/board-worktree",
        workspaceProvisionType: "managed-worktree",
        branchName: "feat/board",
      },
      host: { id: "host-one", name: "Test host" },
      provider: { id: "codex", model: "gpt-5.6-sol" },
      origin: { kind: null, pluginId: null },
    });

    expect(configuration.instructions).toContain(
      "Use review for external /code-review",
    );
    expect(configuration.instructions).toContain(
      "For Git Worktree delivery, use /delivery",
    );

    await harness.lifecycle.dispose();
  });

  it("lists the fixed workflow stages through the CLI", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "treelanes" });
    await plugin(bb);
    const result = await harness.behavior.runCli(["stages"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tickets\tTickets");
    expect(result.stdout).toContain("done\tDone");
    await harness.lifecycle.dispose();
  });

  it("requires the Design owner to submit evidence before advancing", async () => {
    const root = worktreeThread({
      id: "thread-design",
      projectId: "project-one",
      title: "Design the change",
      parentThreadId: null,
    });
    const child = worktreeThread({
      id: "thread-grilling",
      projectId: "project-one",
      title: "Grill the design",
      parentThreadId: root.id,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: sdkFor([root, child]),
    });
    await plugin(bb);
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "design",
    });
    child.status = "idle";
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: child,
      lastAssistantText: "Grilling is finished.\n[workflow:grilling-complete]",
    });
    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: root.projectId,
    })) as { cards: Array<{ stage: string; note: string | null }> };
    expect(board.cards[0]).toMatchObject({
      stage: "design",
      note: null,
    });

    await harness.behavior.callAgentTool(
      "treelanes_move_card",
      { stage: "design", note: "The design worker owns this stage." },
      { threadId: child.id, projectId: child.projectId },
    );
    await recordStageCompletion(harness, child);
    child.status = "idle";
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: child,
      lastAssistantText: "Grilling is finished.\n[workflow:grilling-complete]",
    });
    const advancedBoard = (await harness.behavior.callRpc("getBoard", {
      projectId: root.projectId,
    })) as { cards: Array<{ stage: string; note: string | null }> };
    expect(advancedBoard.cards[0]).toMatchObject({
      stage: "tdd",
      note: "Stage completed with checks.",
    });
    await harness.lifecycle.dispose();
  });

  it("does not treat future Grilling work as finished", () => {
    expect(reportsFinishedGrilling("We still need to finish Grilling.")).toBe(false);
    expect(reportsFinishedGrilling("Grilling is complete.")).toBe(false);
  });

  it("moves through the Implementation steps", async () => {
    const root = worktreeThread({
      id: "thread-implementation",
      projectId: "project-one",
      title: "Build the change",
      parentThreadId: null,
    });
    root.providerId = "codex";
    const threads = [root];
    const stageThreadIds = [
      "thread-tdd",
      "thread-quality",
      "thread-simplify",
      "thread-pr",
    ];
    let spawnIndex = 0;
    const sdk = sdkFor(threads);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: {
        ...sdk,
        threads: {
          ...sdk.threads,
          spawn: async () => {
            const thread = worktreeThread({
              id: stageThreadIds[spawnIndex]!,
              projectId: "project-one",
              title: "Run the next Worktree Stage",
              parentThreadId: root.id,
            });
            thread.providerId = spawnIndex === 2 ? "claude-code" : "codex";
            spawnIndex += 1;
            threads.push(thread);
            return thread;
          },
        },
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "design",
    });
    await harness.behavior.callRpc("moveCard", {
      environmentId: "environment-one",
      stage: "tdd",
    });

    let stageThread = threads[1]!;
    for (const [marker, stage] of [
      ["[workflow:tdd-complete]", "quality"],
      ["[workflow:quality-clear]", "simplify"],
      ["[workflow:simplify-complete]", "pr"],
    ] as const) {
      await recordStageCompletion(harness, stageThread);
      stageThread.status = "idle";
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: stageThread,
        lastAssistantText: `The checks passed.\n${marker}`,
      });
      const board = (await harness.behavior.callRpc("getBoard", {
        projectId: root.projectId,
      })) as { cards: Array<{ stage: string }> };
      expect(board.cards[0]?.stage).toBe(stage);
      if (stage !== "pr") stageThread = threads[threads.length - 1]!;
    }
    expect(spawnIndex).toBe(4);
    await harness.lifecycle.dispose();
  });

  it("does not move Implementation for work that is still pending", () => {
    expect(automatedNextStage("tdd", "We still need to finish TDD.")).toBeNull();
    expect(automatedNextStage("quality", "The review still has two findings.")).toBeNull();
    expect(automatedNextStage("simplify", "Next, run Simplify.")).toBeNull();
  });

  it("excludes each thread that remains Settled and removes an empty worktree", async () => {
    const settled = {
      ...worktreeThread({
        id: "thread-settled",
        projectId: "project-one",
        title: "Quiet settled work",
        parentThreadId: null,
      }),
      latestAttentionAt: 100,
    };
    const activeAgain = {
      ...worktreeThread({
        id: "thread-active-again",
        projectId: "project-one",
        title: "Settled work with new attention",
        parentThreadId: null,
        environmentId: "environment-two",
      }),
      latestAttentionAt: 100,
    };
    const sdk = sdkFor([settled, activeAgain]);
    const { bb, harness } = createFakePluginHost({ pluginId: "treelanes", sdk });
    await plugin(bb);
    await harness.behavior.callRpc("settleThread", { threadId: settled.id });
    await harness.behavior.callRpc("settleThread", { threadId: activeAgain.id });
    activeAgain.latestAttentionAt = Date.now() + 60_000;
    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: "project-one",
    })) as { cards: Array<{ environmentId: string; threads: Array<{ id: string }> }> };
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]).toMatchObject({ environmentId: "environment-two" });
    expect(board.cards[0]?.threads.map((thread) => thread.id)).toEqual([activeAgain.id]);
    await harness.lifecycle.dispose();
  });

  it("settles only the chosen thread and removes the last settled Worktree Card", async () => {
    const threads = ["root", "child"].map((id) => worktreeThread({
      id, projectId: "project-one", status: "idle", updatedAt: 1,
      parentThreadId: id === "child" ? "root" : null,
    }));
    const { bb, harness } = createFakePluginHost({ pluginId: "treelanes", sdk: sdkFor(threads) });
    await plugin(bb);
    try {
      await expect(harness.behavior.callRpc("settleThread", { threadId: "child" })).resolves.toEqual({ ok: true });
      const board = await harness.behavior.callRpc("getBoard", { projectId: "project-one" }) as { cards: Array<{ threads: Array<{ id: string; canSettle: boolean }> }> };
      expect(board.cards[0]?.threads.map(({ id, canSettle }) => ({ id, canSettle }))).toEqual([{ id: "root", canSettle: true }]);
      await harness.behavior.callRpc("settleThread", { threadId: "root" });
      expect(await harness.behavior.callRpc("getBoard", { projectId: "project-one" })).toMatchObject({ cards: [] });
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally { await harness.lifecycle.dispose(); }
  });

  it.each(["active", "question", "background", "outside"])("does not hide a thread when settling is blocked: %s", async (reason) => {
    const thread = {
      ...worktreeThread({ id: "thread-one", projectId: "project-one", status: reason === "active" ? "active" : "idle" }),
      hasPendingInteraction: reason === "question",
      ...(reason === "background" ? { activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 1, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeGoalCount: 0 } } : {}),
      ...(reason === "outside" ? { environmentWorkspaceDisplayKind: "other" as const } : {}),
    };
    const sdk = sdkFor([]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: { ...sdk, threads: { ...sdk.threads, get: async () => thread, list: async () => [thread] } },
    });
    await plugin(bb);
    try {
      await expect(harness.behavior.callRpc("settleThread", { threadId: thread.id })).rejects.toThrow(
        reason === "outside" ? "not on the board" : "live work or a pending question",
      );
      expect(await harness.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
      expect(harness.realtimeSignals).toHaveLength(0);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("ignores threads that are not in Git worktrees", async () => {
    const thread = {
      ...worktreeThread({
        id: "thread-folder",
        projectId: "project-one",
        title: "Folder work",
        parentThreadId: null,
      }),
      environmentWorkspaceDisplayKind: "other" as const,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "treelanes",
      sdk: sdkFor([thread]),
    });
    await plugin(bb);
    const board = (await harness.behavior.callRpc("getBoard", {
      projectId: "project-one",
    })) as { cards: unknown[] };
    expect(board.cards).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("rejects an unknown stage", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "treelanes" });
    await plugin(bb);
    const result = await harness.behavior.runCli(["move", "ship"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Stage must be one of");
    await harness.lifecycle.dispose();
  });
});
