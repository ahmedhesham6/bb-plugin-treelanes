import {
  defineRpcContract,
  type BbPluginApi,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { captureWorkspace, completionEvidenceSchema, taskContextSchema } from "./stage-evidence";
import { nextDeliveryStage, requiredStageChecks } from "./delivery-plan";
import { activeSetupStep, nextSetupStep, validateSetupRevision } from "./setup-plan";
import { resolveStepExecution } from "./step-execution";
import { createSetupAutomation, setupAutomationMigration } from "./setup-automation";
import { setupProposalSchema } from "./setup-request";
import {
  DEFAULT_STAGE,
  STAGE_IDS,
  STAGES,
  isStageId,
  reportedCompletionTransition,
  stageLabel,
  type StageId,
} from "./workflow";

const PR_DESCRIPTION_INSTRUCTION =
  "/show-me When you create a pull request, write its description with simple words and short sentences. State what changed and how you checked it. Add only the smallest GitHub Markdown visual that helps a reviewer understand the change. When you reuse an open pull request, keep its current description.";
const PR_CHECK_FAILURE_INSTRUCTION =
  "Keep PR Watch moving when a check fails. Diagnose each failure. Fix every failure caused by the current branch, then rerun the relevant check until it passes. For a failure that is pre-existing, unrelated to the branch, flaky, or caused by missing test data, secrets, or services, record the command and failure in the pull request description and continue. Commit and push the valid branch changes, create or reuse the pull request, and run /babysit-pr even when a recorded external failure remains. Use pull request checks to confirm the result in the normal CI environment.";
const PR_UI_PROOF_INSTRUCTION =
  "UI proof: inspect the branch diff for user-visible UI changes. When UI changed, run the changed app and capture at least one clear screenshot of the changed state. Give each image plain alt text. For a new pull request, upload each screenshot with `gh pr create --attach '<path>#<alt text>'`. For an open pull request, use `gh pr edit <number> --attach '<path>#<alt text>'` so its current description stays intact. Use a GitHub CLI release whose command help lists `--attach`. Keep local screenshot files out of the commit. Before /babysit-pr, run `gh pr view --json body` and confirm that the pull request body contains each uploaded screenshot. When no user-visible UI changed, continue without a screenshot.";
const OLD_PR_STOP_INSTRUCTION =
  "If a required check cannot pass, stop and report the blocker without opening a pull request.";

function withRequiredPrInstructions(prompt: string): string {
  const base = prompt.replace(OLD_PR_STOP_INSTRUCTION, "").trim();
  return [
    base,
    PR_CHECK_FAILURE_INSTRUCTION,
    PR_UI_PROOF_INSTRUCTION,
    PR_DESCRIPTION_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const stageSchema = z.enum(STAGE_IDS);
const threadStatusSchema = z.enum([
  "error",
  "pending",
  "stopping",
  "idle",
  "starting",
  "active",
]);

const t3LifecycleOutputSchema = z.object({
  rows: z.array(
    z.object({
      threadId: z.string(),
      settledAt: z.number().nullable(),
      snoozedUntil: z.number().nullable(),
      snoozedAt: z.number().nullable(),
    }),
  ),
});

const workThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: threadStatusSchema,
  updatedAt: z.number(),
  parentThreadId: z.string().nullable(),
  hasPendingInteraction: z.boolean(),
});

const cardSchema = z.object({
  environmentId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  worktreeName: z.string(),
  branchName: z.string().nullable(),
  stage: stageSchema,
  note: z.string().nullable(),
  status: threadStatusSchema,
  hasPendingInteraction: z.boolean(),
  updatedAt: z.number(),
  stageUpdatedAt: z.number(),
  pendingThreadStart: z
    .object({ stage: stageSchema, label: z.string() })
    .nullable(),
  threads: z.array(workThreadSchema),
});

const boardOutputSchema = z.object({
  stages: z.array(
    z.object({
      id: stageSchema,
      label: z.string(),
      shortLabel: z.string(),
      description: z.string(),
    }),
  ),
  cards: z.array(cardSchema),
});

const newThreadRequestSchema = z.custom<NewThreadRequest>((value) => {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.projectId === "string" &&
    typeof request.providerId === "string" &&
    typeof request.model === "string" &&
    typeof request.reasoningLevel === "string" &&
    typeof request.permissionMode === "string" &&
    Array.isArray(request.input) &&
    Boolean(request.environment) &&
    typeof request.environment === "object" &&
    Boolean(request.executionInputSources) &&
    typeof request.executionInputSources === "object"
  );
});

const composerDefaultsOutputSchema = z.object({
  providerId: z.string(),
  model: z.string().optional(),
  serviceTier: z.enum(["default", "fast"]).optional(),
  reasoningLevel: z
    .enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"])
    .optional(),
  permissionMode: z.enum(["full", "auto", "accept-edits"]).optional(),
});

export type BoardResult = z.infer<typeof boardOutputSchema>;
export type ComposerDefaultsResult = z.infer<typeof composerDefaultsOutputSchema>;

export const rpcContract = defineRpcContract({
  getBoard: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: boardOutputSchema,
  },
  moveCard: {
    input: z
      .object({
        environmentId: z.string(),
        stage: stageSchema,
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
    output: z.object({ environmentId: z.string(), stage: stageSchema }),
  },
  createThread: {
    input: z.object({ request: newThreadRequestSchema }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  getComposerDefaults: {
    input: z.object({ threadId: z.string() }).strict(),
    output: composerDefaultsOutputSchema,
  },
  startStageThread: {
    input: z.object({ environmentId: z.string() }).strict(),
    output: z.object({ threadId: z.string() }),
  },
});

type ThreadRow = {
  id: string;
  projectId: string;
  environmentId: string | null;
  environmentName: string | null;
  environmentBranchName: string | null;
  environmentWorkspaceDisplayKind:
    | "managed-worktree"
    | "unmanaged-worktree"
    | "other";
  title: string | null;
  titleFallback: string | null;
  providerId: string;
  status:
    | "error"
    | "pending"
    | "stopping"
    | "idle"
    | "starting"
    | "active";
  parentThreadId: string | null;
  hasPendingInteraction?: boolean;
  latestAttentionAt?: number;
  activity?: {
    activeWorkflowCount: number;
    activeBackgroundAgentCount: number;
    activeBackgroundCommandCount: number;
    activePlanModeCount: number;
    activeGoalCount: number;
  };
  createdAt: number;
  updatedAt: number;
};

type WorktreeStateRow = {
  environment_id: string;
  stage: string;
  note: string | null;
  updated_at: number;
  owner_thread_id?: string | null;
  active_step_id?: string | null;
};

type LegacyCardStateRow = {
  thread_id: string;
  stage: string;
  note: string | null;
  updated_at: number;
};

type StageThreadLaunchRow = {
  environment_id: string;
  stage: string;
  stage_updated_at: number;
  status: "pending" | "starting" | "started" | "failed" | "blocked" | "paused";
  thread_id: string | null;
  attempt_count: number;
  updated_at: number;
  next_attempt_at: number;
  last_error: string | null;
};

function displayTitle(thread: ThreadRow): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function hasLiveWork(
  thread: Pick<ThreadRow, "status" | "activity">,
): boolean {
  const activity = thread.activity;
  return (
    thread.status === "active" ||
    thread.status === "pending" ||
    thread.status === "starting" ||
    thread.status === "stopping" ||
    (activity?.activeWorkflowCount ?? 0) > 0 ||
    (activity?.activeBackgroundAgentCount ?? 0) > 0 ||
    (activity?.activeBackgroundCommandCount ?? 0) > 0 ||
    (activity?.activePlanModeCount ?? 0) > 0 ||
    (activity?.activeGoalCount ?? 0) > 0
  );
}

function worktreeStatus(threads: ThreadRow[]): ThreadRow["status"] {
  if (threads.some((thread) => thread.status === "error")) return "error";
  if (threads.some(hasLiveWork)) return "active";
  return "idle";
}

function isWorktreeThread(thread: ThreadRow): boolean {
  return (
    thread.environmentId !== null &&
    thread.environmentWorkspaceDisplayKind !== "other"
  );
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoAdvanceGrilling: {
      type: "boolean",
      label: "Move finished Grilling to TDD",
      default: true,
    },
    autoAdvanceImplementation: {
      type: "boolean",
      label: "Move through Implementation when work finishes",
      default: true,
    },
    tddProviderId: {
      type: "string",
      label: "TDD provider (blank uses the current thread)",
      default: "",
    },
    tddModel: {
      type: "string",
      label: "TDD model (blank uses the current thread)",
      default: "",
    },
    tddPrompt: {
      type: "string",
      label: "TDD prompt",
      default:
        "/tdd Implement the approved design in this Git Worktree. Use the agreed test seams and work test-first. Make the smallest complete change and preserve unrelated behavior. Run the relevant tests and type checks. Finish only when the design is implemented and all checks pass. End with [workflow:tdd-complete].",
    },
    reviewProviderId: {
      type: "string",
      label: "Quality review provider (blank uses the current thread)",
      default: "",
    },
    reviewModel: {
      type: "string",
      label: "Quality review model (blank uses the current thread)",
      default: "",
    },
    reviewPrompt: {
      type: "string",
      label: "Quality review prompt",
      default:
        "/thermo-nuclear-code-quality-review Review every change in this Git Worktree. Fix each valid finding within the approved design, then review again. Run the relevant tests and type checks after each fix. Finish only when no findings remain and all checks pass. End with [workflow:quality-clear].",
    },
    simplifyModel: {
      type: "string",
      label: "Claude Code main model for Simplify",
      default: "claude-fable-5",
    },
    simplifyPrompt: {
      type: "string",
      label: "Simplify prompt",
      default:
        "/simplify Simplify the current changes in this Git Worktree without changing behavior or widening scope. Use Fable as the main agent. For each child agent you start, set its model to opus. Remove needless code and complexity. Keep public interfaces and tests valid. Run the relevant tests and type checks. Finish only when behavior is unchanged and all checks pass. End with [workflow:simplify-complete].",
    },
    simplifyToPrMode: {
      type: "select",
      label: "Simplify to PR thread",
      options: ["ask", "auto"],
      default: "auto",
    },
    prProviderId: {
      type: "string",
      label: "PR provider",
      default: "codex",
    },
    prModel: {
      type: "string",
      label: "PR model",
      default: "gpt-5.6-sol",
    },
    prPrompt: {
      type: "string",
      label: "PR prompt (the description rule is always added)",
      default:
        "First, inspect all staged, unstaged, and untracked changes. Stage every implementation file that belongs to the current change, including source code, tests, required configuration, migrations, generated files, and lockfiles. Never stage or commit a design, planning, or workflow context document. This includes ADRs, design documents, plans, discussion notes, temporary specs, and CONTEXT.md. If any such file is already staged, remove it from the index without changing or deleting its working-tree file. Remove all other unrelated files from the index without changing their working-tree contents. Before committing, find and read each contribution guide that exists and applies to the changed files, including CONTRIBUTING files and contribution documents they link to. If no contribution guide exists, continue. Validate the implementation files, required checks, branch and commit names, and pull request title and body against the guides. Fix each valid gap before pushing or opening the pull request. Commit only the implementation files with a concise message. Push the current branch and all unpushed commits, and set its upstream when needed. Then determine the current branch and its Git Worktree base branch. Find an open pull request from the current branch to that base branch. If none exists, create a ready-for-review pull request against the base branch. Do not create a draft. Write a concise title and body that state the change and validation. Then run /babysit-pr on that pull request. Stay on duty until it is ready to merge, merged, or closed. Never merge it yourself. Assign the Worktree Stage to done only after it merges.",
    },
  });
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS cards (
      thread_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_history_thread_idx
      ON card_history(thread_id, changed_at DESC);`,
    `UPDATE cards SET stage = 'tdd' WHERE stage = 'approved';`,
    `CREATE TABLE IF NOT EXISTS worktree_cards (
      environment_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktree_card_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worktree_card_history_environment_idx
      ON worktree_card_history(environment_id, changed_at DESC);`,
    `CREATE TABLE IF NOT EXISTS worktree_stage_thread_launches (
      environment_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      stage_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      PRIMARY KEY (environment_id, stage, stage_updated_at)
    );`,
    `ALTER TABLE worktree_stage_thread_launches ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE worktree_stage_thread_launches ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE worktree_stage_thread_launches ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE worktree_stage_thread_launches ADD COLUMN last_error TEXT;
    ALTER TABLE worktree_cards ADD COLUMN owner_thread_id TEXT;
    CREATE TABLE worktree_task_contexts (
      environment_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, context_json TEXT NOT NULL
    );
    CREATE TABLE worktree_stage_results (
      environment_id TEXT NOT NULL, stage_updated_at INTEGER NOT NULL,
      thread_id TEXT NOT NULL, task_revision INTEGER NOT NULL, evidence_json TEXT NOT NULL,
      PRIMARY KEY(environment_id, stage_updated_at)
    );
    CREATE TABLE worktree_controls (
      environment_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE TABLE worktree_setup_projects (environment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    ALTER TABLE worktree_cards ADD COLUMN active_step_id TEXT;
    ALTER TABLE worktree_stage_thread_launches ADD COLUMN execution_json TEXT;
    ALTER TABLE worktree_stage_results ADD COLUMN step_id TEXT;
    CREATE TABLE worktree_task_versions (
      environment_id TEXT NOT NULL, revision INTEGER NOT NULL, context_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(environment_id, revision)
    );
    INSERT INTO worktree_task_versions SELECT environment_id, revision, context_json, 0 FROM worktree_task_contexts;
    CREATE TABLE worktree_setup_outcomes (
      environment_id TEXT NOT NULL, task_revision INTEGER NOT NULL, project_id TEXT NOT NULL,
      outcome_json TEXT NOT NULL, completed_at INTEGER NOT NULL,
      PRIMARY KEY(environment_id, task_revision)
    );`,
    setupAutomationMigration,
  ]);

  const readWorktreeState = db.prepare(
    "SELECT environment_id, stage, note, updated_at, owner_thread_id, active_step_id FROM worktree_cards WHERE environment_id = ?",
  );
  const readAllWorktreeStates = db.prepare(
    "SELECT environment_id, stage, note, updated_at, owner_thread_id, active_step_id FROM worktree_cards",
  );
  const readAllLegacyStates = db.prepare(
    "SELECT thread_id, stage, note, updated_at FROM cards",
  );
  const readLegacyState = db.prepare(
    "SELECT thread_id, stage, note, updated_at FROM cards WHERE thread_id = ?",
  );
  const saveWorktreeState = db.prepare(`
    INSERT INTO worktree_cards (environment_id, stage, note, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(environment_id) DO UPDATE SET
      stage = excluded.stage,
      note = excluded.note,
      updated_at = excluded.updated_at
  `);
  const addWorktreeHistory = db.prepare(`
    INSERT INTO worktree_card_history
      (environment_id, stage, note, source, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const readStageThreadLaunch = db.prepare(`
    SELECT environment_id, stage, stage_updated_at, status, thread_id, attempt_count, updated_at, next_attempt_at, last_error
    FROM worktree_stage_thread_launches
    WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?
  `);
  const readStartedStageThreadLaunches = db.prepare(`
    SELECT environment_id, stage, stage_updated_at, status, thread_id, attempt_count, updated_at, next_attempt_at, last_error
    FROM worktree_stage_thread_launches
    WHERE environment_id = ? AND stage = ? AND status = 'started'
      AND thread_id IS NOT NULL
    ORDER BY stage_updated_at DESC
  `);
  const saveStageThreadLaunch = db.prepare(`
    INSERT INTO worktree_stage_thread_launches
      (environment_id, stage, stage_updated_at, status, thread_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(environment_id, stage, stage_updated_at) DO UPDATE SET
      status = excluded.status,
      thread_id = excluded.thread_id,
      last_error = NULL
  `);
  const claimStageThreadLaunch = db.prepare(`
    INSERT INTO worktree_stage_thread_launches
      (environment_id, stage, stage_updated_at, status, thread_id)
    VALUES (?, ?, ?, 'starting', NULL)
    ON CONFLICT(environment_id, stage, stage_updated_at) DO NOTHING
  `);
  const addPendingStageThreadLaunch = db.prepare(`
    INSERT INTO worktree_stage_thread_launches
      (environment_id, stage, stage_updated_at, status, thread_id)
    VALUES (?, ?, ?, 'pending', NULL)
    ON CONFLICT(environment_id, stage, stage_updated_at) DO NOTHING
  `);
  const stageThreadStarts = new Map<string, Promise<{ id: string }>>();
  const readTask = db.prepare("SELECT revision, context_json FROM worktree_task_contexts WHERE environment_id = ?");
  const readResult = db.prepare("SELECT thread_id, task_revision, evidence_json FROM worktree_stage_results WHERE environment_id = ? AND stage_updated_at = ?");
  const setOwner = db.prepare("UPDATE worktree_cards SET owner_thread_id = ? WHERE environment_id = ? AND updated_at = ?");
  const paused = (environmentId: string) => Boolean((db.prepare("SELECT paused FROM worktree_controls WHERE environment_id = ?").get(environmentId) as { paused: number } | undefined)?.paused);
  const launchTitle = (environmentId: string, stage: string, revision: number) => `Workflow ${stageLabel(stage as StageId)} [${environmentId}:${stage}:${revision}]`;
  function taskFor(environmentId: string) {
    const row = readTask.get(environmentId) as { revision: number; context_json: string } | undefined;
    return { revision: row?.revision ?? 0, task: row ? taskContextSchema.parse(JSON.parse(row.context_json)) : null };
  }
  const setupAutomation = createSetupAutomation(bb, db, {
    context(environmentId) {
      const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
      const saved = taskFor(environmentId);
      if (!state) throw new Error("The setup worktree has no assigned stage.");
      return { environmentId, stage: state.stage, stageUpdatedAt: state.updated_at, taskRevision: saved.revision,
        task: saved.task, activeStepId: state.active_step_id ?? null, paused: paused(environmentId) };
    },
    commit(request, plan) {
      const saved = taskFor(request.environment_id);
      const state = readWorktreeState.get(request.environment_id) as WorktreeStateRow;
      if (!saved.task || saved.revision !== request.task_revision || state.updated_at !== request.stage_updated_at || paused(request.environment_id)) throw new Error("Setup context changed before commit.");
      const task = taskContextSchema.parse({ ...saved.task, setup: plan });
      const revision = saved.revision + 1;
      const version = Math.max(Date.now(), state.updated_at + 1);
      const activeId = request.kind === "initial" ? plan.steps[0]!.id : state.active_step_id;
      db.prepare("UPDATE worktree_task_contexts SET revision = ?, context_json = ? WHERE environment_id = ?").run(revision, JSON.stringify(task), request.environment_id);
      db.prepare("INSERT INTO worktree_task_versions VALUES (?, ?, ?, ?)").run(request.environment_id, revision, JSON.stringify(task), Date.now());
      db.prepare("UPDATE worktree_stage_thread_launches SET status = 'paused', last_error = 'Replaced by a validated setup revision' WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .run(request.environment_id, state.stage, state.updated_at);
      db.prepare("UPDATE worktree_cards SET updated_at = ?, active_step_id = ?, owner_thread_id = NULL WHERE environment_id = ?")
        .run(version, activeId, request.environment_id);
      addPendingStageThreadLaunch.run(request.environment_id, state.stage, version);
      addWorktreeHistory.run(request.environment_id, state.stage, request.kind === "initial" ? "Automatic setup accepted" : "Bounded plan recovery accepted", "automation", version);
    },
    playbooks: setupPlaybooks,
    listThreads: projectId => listThreads(projectId),
    hasLiveWork,
    disposed: () => disposed,
  });

  function failLaunch(environmentId: string, stage: string, revision: number, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    db.prepare(`UPDATE worktree_stage_thread_launches SET status = CASE WHEN attempt_count >= 3 THEN 'blocked' ELSE 'failed' END,
      last_error = ?, updated_at = ?, next_attempt_at = ?
      WHERE environment_id = ? AND stage = ? AND stage_updated_at = ? AND status = 'starting'`)
      .run(message, Date.now(), Date.now() + 30_000, environmentId, stage, revision);
    bb.log.error(`Stage launch failed for ${environmentId}/${stage}: ${message}`);
  }


  async function listThreads(projectId?: string, archived = false): Promise<ThreadRow[]> {
    const rows: ThreadRow[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = (await bb.sdk.threads.list({
        ...(projectId ? { projectId } : {}),
        archived,
        includeHidden: true,
        limit,
        offset,
      })) as ThreadRow[];
      rows.push(...page);
      if (page.length < limit) break;
    }
    return rows;
  }

  async function worktreeForThread(threadId: string): Promise<{
    environmentId: string;
    worktreeName: string;
  }> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      throw new Error("This thread is not in a Git worktree.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.isGitRepo || !environment.isWorktree) {
      throw new Error("This thread is not in a Git worktree.");
    }
    return {
      environmentId: thread.environmentId,
      worktreeName:
        environment.name ??
        environment.branchName ??
        thread.environmentId,
    };
  }

  async function legacyStateForThread(
    threadId: string,
  ): Promise<LegacyCardStateRow | undefined> {
    let thread = await bb.sdk.threads.get({ threadId });
    const seen = new Set<string>();
    while (thread.parentThreadId) {
      if (seen.has(thread.id)) break;
      seen.add(thread.id);
      thread = await bb.sdk.threads.get({ threadId: thread.parentThreadId });
    }
    return readLegacyState.get(thread.id) as LegacyCardStateRow | undefined;
  }

  async function readT3Lifecycle() {
    try {
      return await bb.sdk.plugins.callRpc({
        pluginId: "t3sidebar",
        method: "listLifecycle",
        input: {},
        outputSchema: t3LifecycleOutputSchema,
      });
    } catch (error) {
      bb.log.debug(
        `Could not read T3 Sidebar lifecycle: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { rows: [] };
    }
  }

  async function startStageThread(
    environmentId: string,
    requested: { providerId: string; model: string; prompt: string },
    stage?: StageId,
    stageUpdatedAt?: number,
  ) {
    const environment = await bb.sdk.environments.get({ environmentId });
    const threads = (await listThreads(environment.projectId))
      .filter((thread) => thread.environmentId === environmentId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const sourceThread = threads[0];
    if (!sourceThread) {
      throw new Error("The Git Worktree has no thread to use for TDD settings.");
    }
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const seen = new Set([sourceThread.id]);
    let mainThread: Pick<
      ThreadRow,
      "id" | "parentThreadId" | "environmentId"
    > = sourceThread;
    while (mainThread.parentThreadId && !seen.has(mainThread.parentThreadId)) {
      const parent =
        threadById.get(mainThread.parentThreadId) ??
        (await bb.sdk.threads.get({
          threadId: mainThread.parentThreadId,
        }));
      if (parent.environmentId !== environmentId) break;
      seen.add(parent.id);
      mainThread = parent;
    }
    const execution = await bb.sdk.threads.defaultExecutionOptions({
      threadId: sourceThread.id,
    });
    const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
    const savedRevision = taskFor(environmentId).revision;
    const savedTask = taskFor(environmentId).task;
    const step = activeSetupStep(savedTask?.setup, state?.active_step_id);
    let selected: Awaited<ReturnType<typeof resolveStepExecution>> | null = null;
    if (step && state) {
      const prior = db.prepare("SELECT execution_json FROM worktree_stage_thread_launches WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .get(environmentId, state.stage, state.updated_at) as { execution_json: string | null } | undefined;
      selected = prior?.execution_json ? JSON.parse(prior.execution_json) : await resolveStepExecution(bb.sdk, { environmentId, projectId: environment.projectId }, step.execution);
      db.prepare("UPDATE worktree_stage_thread_launches SET execution_json = ? WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .run(JSON.stringify(selected), environmentId, state.stage, state.updated_at);
    }
    const providerId = selected?.providerId ?? (requested.providerId.trim() || sourceThread.providerId);
    const requestedModel = selected?.model ?? requested.model.trim();
    const canInheritExecution =
      providerId === sourceThread.providerId &&
      (!requestedModel || requestedModel === execution?.model);
    let model = requestedModel || (canInheritExecution ? execution?.model : undefined);
    let reasoningLevel = selected?.reasoningLevel ?? (canInheritExecution
      ? execution?.reasoningLevel
      : undefined);
    if (!model || !reasoningLevel) {
      const options = await bb.sdk.providers.models({
        environmentId,
        providerId,
      });
      const selected = requestedModel
        ? options.models.find(
            (candidate) =>
              candidate.model === requestedModel || candidate.id === requestedModel,
          )
        : options.models.find((candidate) => candidate.isDefault) ??
          options.models[0];
      model = selected?.model ?? model;
      reasoningLevel = selected?.defaultReasoningEffort ?? reasoningLevel;
    }
    if (!model) {
      throw new Error(`Set a model for provider ${providerId}.`);
    }

    const previous = db.prepare("SELECT thread_id, evidence_json FROM worktree_stage_results WHERE environment_id = ? ORDER BY stage_updated_at DESC LIMIT 1")
      .get(environmentId) as { thread_id: string; evidence_json: string } | undefined;
    const handoff = { environmentId, stage: stage ?? state?.stage, stageUpdatedAt: stageUpdatedAt ?? state?.updated_at,
      taskRevision: taskFor(environmentId).revision, task: step && savedTask ? { ...savedTask, setup: { summary: savedTask.setup!.summary } } : savedTask,
      activeStep: step, execution: selected,
      requiredChecks: [...new Set([...requiredStageChecks(stage ?? state?.stage ?? "", savedTask), ...(step?.checks ?? [])])],
      nextStage: savedTask?.setup ? nextSetupStep(savedTask.setup, state?.active_step_id)?.stage ?? null : nextDeliveryStage(stage ?? state?.stage ?? "", savedTask),
      previousThreadId: previous?.thread_id ?? sourceThread.id,
      previousResult: previous ? JSON.parse(previous.evidence_json) : null, policyVersion: 1 };
    if (disposed || paused(environmentId) || taskFor(environmentId).revision !== savedRevision || (stageUpdatedAt !== undefined &&
        (readWorktreeState.get(environmentId) as WorktreeStateRow | undefined)?.updated_at !== stageUpdatedAt)) {
      throw new Error("The stage changed or paused before worker dispatch.");
    }
    return bb.sdk.threads.spawn({
      ...(stage !== undefined && stageUpdatedAt !== undefined ? { title: launchTitle(environmentId, stage, stageUpdatedAt) } : {}),
      projectId: environment.projectId,
      parentThreadId: mainThread.id,
      providerId,
      model,
      reasoningLevel: reasoningLevel ?? "medium",
      permissionMode: execution?.permissionMode ?? "auto",
      ...(canInheritExecution && execution?.serviceTier
        ? { serviceTier: execution.serviceTier }
        : {}),
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
        ...(canInheritExecution && execution?.serviceTier
          ? { serviceTier: "explicit" as const }
          : {}),
      },
      environment: { type: "reuse", environmentId },
      prompt: `${step ? `Use /delivery. Execute only the saved step: ${step.title}. ${step.instructions}\nRead these selected skills before work: ${JSON.stringify(selected?.selectedSkills)}.\n${step.stage === "pr" ? requested.prompt : "Use the saved checks as the completion criteria. Keep the approved scope and test interfaces."}` : requested.prompt}

Saved worktree handoff:
${JSON.stringify(handoff)}
Read the saved task and prior thread for scope, accepted decisions, test interfaces, and required checks. Adapt only remaining setup steps, or legacy deliveryStages and stageChecks, to the task and new findings; retain explicit required checks and the current stage. Use the delivery skill to select relevant work and recover temporary errors. Reuse decisions that still apply. Use bb workflow-board context to get the current owner, task revision, stage revision, and workspace digest. If the task is absent, save the agreed scope with bb workflow-board task before implementation. For Design, TDD, Quality, or Simplify, submit check evidence using bb workflow-board complete after all changes and checks, then end with the exact stage marker on its own line. A marker alone cannot advance the card. Re-read context after any task or file change. Keep external Code Review separate. The board owns the next stage; do not spawn a second stage worker.`,
    });
  }

  async function findLiveStageWorker(
    environmentId: string,
    stage: StageId,
  ) {
    const launches = readStartedStageThreadLaunches.all(
      environmentId,
      stage,
    ) as StageThreadLaunchRow[];
    for (const launch of launches) {
      if (!launch.thread_id) continue;
      try {
        const thread = await bb.sdk.threads.get({ threadId: launch.thread_id });
        if (thread.environmentId === environmentId && hasLiveWork(thread)) {
          return thread;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async function launchStageThreadOnce(
    environmentId: string, stage: StageId, stageUpdatedAt: number,
    requested: { providerId: string; model: string; prompt: string },
    explicit = false,
  ) {
    if (disposed || paused(environmentId)) return null;
    const current = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
    if (current?.stage !== stage || current.updated_at !== stageUpdatedAt) return null;
    const startKey = `${environmentId}:${stage}`;
    const inFlight = stageThreadStarts.get(startKey);
    if (inFlight) return inFlight;
    const claimed = db.transaction(() => {
      const row = readStageThreadLaunch.get(environmentId, stage, stageUpdatedAt) as StageThreadLaunchRow | undefined;
      if (row?.status === "started" || row?.status === "starting" || row?.status === "paused") return false;
      if (row && (row.status === "blocked" || row.attempt_count >= 3)) return false;
      if (!explicit && row && row.next_attempt_at > Date.now()) return false;
      if (row) {
        db.prepare(`UPDATE worktree_stage_thread_launches SET status = 'starting', updated_at = ?,
          attempt_count = ?, last_error = NULL WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?`)
          .run(Date.now(), row.attempt_count + 1, environmentId, stage, stageUpdatedAt);
      } else {
        claimStageThreadLaunch.run(environmentId, stage, stageUpdatedAt);
        db.prepare("UPDATE worktree_stage_thread_launches SET updated_at = ?, attempt_count = 1 WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
          .run(Date.now(), environmentId, stage, stageUpdatedAt);
      }
      return true;
    })();
    if (!claimed) return null;
    const start = (async () => {
      const environment = await bb.sdk.environments.get({ environmentId });
      const candidates = [...await listThreads(environment.projectId), ...await listThreads(environment.projectId, true)];
      const orphan = candidates.find(thread => thread.environmentId === environmentId && thread.title === launchTitle(environmentId, stage, stageUpdatedAt));
      const liveWorker = orphan ?? await findLiveStageWorker(environmentId, stage);
      const thread = liveWorker ?? await startStageThread(environmentId, requested, stage, stageUpdatedAt);
      saveStageThreadLaunch.run(environmentId, stage, stageUpdatedAt, "started", thread.id);
      setOwner.run(thread.id, environmentId, stageUpdatedAt);
      return thread;
    })();
    stageThreadStarts.set(startKey, start);
    try { return await start; }
    catch (error) { failLaunch(environmentId, stage, stageUpdatedAt, error); throw error; }
    finally { if (stageThreadStarts.get(startKey) === start) stageThreadStarts.delete(startKey); }
  }

  async function startWorkForStage(
    environmentId: string,
    stage: StageId,
    stageUpdatedAt: number,
    explicit = false,
  ) {
    const config = await settings.get();
    if (stage === "tdd") {
      return launchStageThreadOnce(environmentId, stage, stageUpdatedAt, {
        providerId: config.tddProviderId,
        model: config.tddModel,
        prompt: config.tddPrompt,
      }, explicit);
    }
    if (stage === "quality") {
      return launchStageThreadOnce(environmentId, stage, stageUpdatedAt, {
        providerId: config.reviewProviderId,
        model: config.reviewModel,
        prompt: config.reviewPrompt,
      }, explicit);
    }
    if (stage === "simplify") {
      return launchStageThreadOnce(environmentId, stage, stageUpdatedAt, {
        providerId: "claude-code",
        model: config.simplifyModel,
        prompt: config.simplifyPrompt,
      }, explicit);
    }
    if (stage === "pr" && config.simplifyToPrMode === "ask" && !explicit) {
      addPendingStageThreadLaunch.run(environmentId, stage, stageUpdatedAt);
      return null;
    }
    if (stage === "pr") {
      return launchStageThreadOnce(environmentId, stage, stageUpdatedAt, {
        providerId: config.prProviderId,
        model: config.prModel,
        prompt: withRequiredPrInstructions(config.prPrompt),
      }, explicit);
    }
    return null;
  }

  async function moveWorktree(
    environmentId: string,
    stage: StageId,
    note: string | undefined,
    source: "agent" | "automation" | "cli" | "panel",
    nextStepId?: string,
  ) {
    const old = readWorktreeState.get(environmentId) as
      | WorktreeStateRow
      | undefined;
    if (old && old.stage !== stage && (source === "panel" || source === "cli")) {
      if (stageThreadStarts.has(`${environmentId}:${old.stage}`)) throw new Error("A stage worker is starting. Wait for the launch to settle before moving the card.");
      const liveWorker = await findLiveStageWorker(environmentId, old.stage as StageId);
      if (liveWorker) throw new Error("A stage worker is still running. Stop it before changing its stage.");
    }
    const mergedPr = stage === "done" ? await requireMergedPullRequest(environmentId) : null;
    const setup = taskFor(environmentId).task?.setup;
    if (setup && old && stage !== old.stage && stage !== "done" && !nextStepId) {
      if (old.stage === "design" && setup.steps[0]!.stage === stage) nextStepId = setup.steps[0]!.id;
      else throw new Error("This worktree has a saved setup. Revise its remaining steps and complete the current step before moving it.");
    }
    const savedNote = note === undefined ? (old?.note ?? null) : note || null;
    if (old?.stage === stage && (!nextStepId || nextStepId === old.active_step_id)) {
      if (note !== undefined) {
        saveWorktreeState.run(
          environmentId,
          stage,
          savedNote,
          old.updated_at,
        );
      }
      const launch = readStageThreadLaunch.get(environmentId, stage, old.updated_at) as StageThreadLaunchRow | undefined;
      if ((source === "panel" || source === "cli") && launch && ["failed", "blocked", "pending"].includes(launch.status)) {
        await startWorkForStage(environmentId, stage, old.updated_at, true);
      }
      return { environmentId, stage };
    }
    const now = Math.max(Date.now(), (old?.updated_at ?? 0) + 1);
    const shouldStart = (source === "automation" && ["tdd", "quality", "simplify", "pr"].includes(stage)) ||
      (old?.stage === "design" && stage === "tdd") || (old?.stage === "tdd" && stage === "quality") ||
      (old?.stage === "quality" && stage === "simplify") || (old?.stage === "simplify" && stage === "pr");
    db.transaction(() => {
      if (mergedPr && setup && (old?.active_step_id !== setup.steps.at(-1)?.id ||
          !recordSetupOutcome(environmentId, "Pull request merge verified.", { pullRequest: mergedPr }))) {
        throw new Error("The saved setup must complete before Done.");
      }
      saveWorktreeState.run(environmentId, stage, savedNote, now);
      setOwner.run(null, environmentId, now);
      db.prepare("UPDATE worktree_cards SET active_step_id = ? WHERE environment_id = ?").run(nextStepId ?? null, environmentId);
      addWorktreeHistory.run(environmentId, stage, savedNote, source, now);
      if (shouldStart) addPendingStageThreadLaunch.run(environmentId, stage, now);

    })();
    if (shouldStart) await startWorkForStage(environmentId, stage, now);
    bb.realtime.publish("board-changed", { environmentId, stage });
    return { environmentId, stage };
  }

  async function moveThreadWorktree(
    threadId: string,
    stage: StageId,
    note: string | undefined,
    source: "agent" | "automation" | "cli",
  ) {
    if (setupAutomation.isPlanner(threadId)) throw new Error("Setup workers submit plans only.");
    const worktree = await worktreeForThread(threadId);
    let saved = readWorktreeState.get(worktree.environmentId) as
      | WorktreeStateRow
      | undefined;
    if (!saved) {
      const legacy = await legacyStateForThread(threadId);
      if (legacy && isStageId(legacy.stage)) {
        saveWorktreeState.run(
          worktree.environmentId,
          legacy.stage,
          legacy.note,
          legacy.updated_at,
        );
        saved = {
          environment_id: worktree.environmentId,
          stage: legacy.stage,
          note: legacy.note,
          updated_at: legacy.updated_at,
        };
      }
    }
    if (source === "agent" && saved?.stage === "design" && ["tdd", "quality", "simplify", "pr"].includes(stage)) {
      return {
        environmentId: worktree.environmentId,
        stage: "design" as const,
        worktreeName: worktree.worktreeName,
        blockedReason:
          "Design is not finished. Keep the Worktree Card in Design until the user moves it to TDD or the design thread reports [workflow:grilling-complete].",
      };
    }
    if (source === "agent" && saved?.stage === "review" && !["review", "tickets", "design"].includes(stage)) {
      return { ...worktree, stage: "review" as const, blockedReason: "Code Review reports findings and starts no later stage. Use an explicit operator move to start separate implementation work." };
    }
    const implementationOrder = ["tdd", "quality", "simplify", "pr"];
    if (source === "agent" && saved && taskFor(worktree.environmentId).task &&
        ((taskFor(worktree.environmentId).task?.setup && saved.stage !== stage && ["tdd", "quality", "simplify", "pr"].includes(stage)) ||
        implementationOrder.includes(saved.stage) &&
        implementationOrder.indexOf(stage) > implementationOrder.indexOf(saved.stage))) {
      return { ...worktree, stage: saved.stage, blockedReason: "This saved task needs a completion receipt before its next stage. Submit evidence and let the board advance it. An operator can assign a separate task." };
    }
    if (
      source === "agent" &&
      saved &&
      isStageId(saved.stage) &&
      saved.stage !== stage
    ) {
      const liveWorker = await findLiveStageWorker(
        worktree.environmentId,
        saved.stage,
      );
      if (liveWorker && liveWorker.id !== threadId) {
        return {
          environmentId: worktree.environmentId,
          stage: saved.stage,
          worktreeName: worktree.worktreeName,
          blockedReason: `${stageLabel(saved.stage)} worker is still running. A different agent thread cannot move this Worktree Card until that worker finishes.`,
        };
      }
    }
    const result = await moveWorktree(
      worktree.environmentId,
      stage,
      note,
      source,
    );
    const current = readWorktreeState.get(worktree.environmentId) as WorktreeStateRow;
    if (!current.owner_thread_id) setOwner.run(threadId, worktree.environmentId, current.updated_at);
    return {
      ...result,
      worktreeName: worktree.worktreeName,
      blockedReason: null,
    };
  }

  async function requireMergedPullRequest(environmentId: string) {
    const [environment, result] = await Promise.all([
      bb.sdk.environments.get({ environmentId }), bb.sdk.environments.pullRequest({ environmentId }),
    ]);
    if (result.outcome !== "available" || result.pullRequest.state !== "merged" ||
        !environment.branchName || result.pullRequest.headRefName !== environment.branchName) {
      throw new Error("Done requires a verified merged pull request for this worktree branch.");
    }
    return result.pullRequest;
  }

  async function currentContext(threadId: string, snapshot = true) {
    const { environmentId } = await worktreeForThread(threadId);
    const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
    if (!state) throw new Error("Assign a Worktree Stage before recording context.");
    if (!state.owner_thread_id) {
      const launch = readStageThreadLaunch.get(environmentId, state.stage, state.updated_at) as StageThreadLaunchRow | undefined;
      const thread = await bb.sdk.threads.get({ threadId });
      const prepared = db.prepare("SELECT execution_json FROM worktree_stage_thread_launches WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .get(environmentId, state.stage, state.updated_at) as { execution_json: string | null } | undefined;
      const failedBeforeDispatch = taskFor(environmentId).task?.setup && launch && ["failed", "blocked"].includes(launch.status) && !prepared?.execution_json && !launch.thread_id;
      if (launch?.thread_id === threadId || (launch?.status === "starting" && thread.title === launchTitle(environmentId, state.stage, state.updated_at)) || ((!launch || failedBeforeDispatch) && !thread.parentThreadId)) {
        setOwner.run(threadId, environmentId, state.updated_at);
        state.owner_thread_id = threadId;
      }
    }
    const saved = taskFor(environmentId);
    const activeStep = activeSetupStep(saved.task?.setup, state.active_step_id);
    const nextStep = saved.task?.setup ? nextSetupStep(saved.task.setup, state.active_step_id) : null;
    const executionRow = db.prepare("SELECT execution_json FROM worktree_stage_thread_launches WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
      .get(environmentId, state.stage, state.updated_at) as { execution_json: string | null } | undefined;
    return { environmentId, stage: state.stage, stageUpdatedAt: state.updated_at,
      ownerThreadId: state.owner_thread_id ?? null, taskRevision: saved.revision, task: saved.task,
      automaticSetup: setupAutomation.latest(environmentId) ?? null,
      activeStep, nextStep, setupComplete: Boolean(db.prepare("SELECT 1 FROM worktree_setup_outcomes WHERE environment_id = ? AND task_revision = ?").get(environmentId, saved.revision)), completedStepIds: saved.task?.setup?.steps.slice(0, Math.max(0, saved.task.setup.steps.findIndex(step => step.id === state.active_step_id))).map(step => step.id) ?? [],
      execution: executionRow?.execution_json ? JSON.parse(executionRow.execution_json) : null,
      requiredChecks: [...new Set([...requiredStageChecks(state.stage, saved.task), ...(activeStep?.checks ?? [])])],
      nextStage: saved.task?.setup ? nextStep?.stage ?? null : nextDeliveryStage(state.stage, saved.task),
      paused: paused(environmentId),
      ...(snapshot ? { workspaceDigest: await captureWorkspace(bb.sdk, environmentId) } : {}) };
  }

  async function saveTaskContext(threadId: string, input: unknown) {
    if (setupAutomation.isPlanner(threadId)) throw new Error("Setup workers cannot change the authorized task.");
    const task = taskContextSchema.parse(input);
    const context = await currentContext(threadId, false);
    if (context.ownerThreadId !== threadId) throw new Error("Only the current stage owner can change the saved task.");
    if (task.deliveryStages && ["tdd", "quality", "simplify", "pr"].includes(context.stage) &&
        !task.deliveryStages.some(stage => stage === context.stage)) {
      throw new Error("Keep the current stage in the delivery plan. Complete it before continuing.");
    }
    const current = taskFor(context.environmentId);
    if (task.setup && task.deliveryStages) throw new Error("Use a custom setup or deliveryStages, not both.");
    const state = readWorktreeState.get(context.environmentId) as WorktreeStateRow;
    const launch = readStageThreadLaunch.get(context.environmentId, state.stage, state.updated_at) as StageThreadLaunchRow | undefined;
    const prepared = db.prepare("SELECT execution_json FROM worktree_stage_thread_launches WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
      .get(context.environmentId, state.stage, state.updated_at) as { execution_json: string | null } | undefined;
    validateSetupRevision(current.task?.setup, task.setup, state.active_step_id, state.stage, Boolean(prepared?.execution_json || (launch && ["started", "starting"].includes(launch.status))));
    const correctedSelection = launch && ["failed", "blocked"].includes(launch.status) && !prepared?.execution_json &&
      JSON.stringify(activeSetupStep(current.task?.setup, state.active_step_id)?.execution) !== JSON.stringify(activeSetupStep(task.setup, state.active_step_id)?.execution);
    for (const step of task.setup?.steps ?? []) {
      if (new Set([...requiredStageChecks(step.stage, task), ...step.checks]).size > 128) throw new Error("A step can require at most 128 distinct checks.");
    }
    if (JSON.stringify(current.task) === JSON.stringify(task)) return { taskRevision: current.revision, task };
    const revision = current.revision + 1;
    const taskThread = await bb.sdk.threads.get({ threadId });
    const latest = readWorktreeState.get(context.environmentId) as WorktreeStateRow;
    if (latest.updated_at !== state.updated_at || latest.owner_thread_id !== threadId || taskFor(context.environmentId).revision !== current.revision || paused(context.environmentId)) {
      throw new Error("The task or owner changed, or work paused. Read context before saving again.");
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO worktree_task_contexts VALUES (?, ?, ?)
      ON CONFLICT(environment_id) DO UPDATE SET revision = excluded.revision, context_json = excluded.context_json`)
      .run(context.environmentId, revision, JSON.stringify(task));
      db.prepare("INSERT INTO worktree_task_versions VALUES (?, ?, ?, ?)").run(context.environmentId, revision, JSON.stringify(task), Date.now());
      db.prepare("INSERT OR REPLACE INTO worktree_setup_projects VALUES (?, ?)").run(context.environmentId, taskThread.projectId);
      if (correctedSelection) {
        const version = Math.max(Date.now(), state.updated_at + 1);
        db.prepare("UPDATE worktree_stage_thread_launches SET status = 'paused', last_error = 'Selection corrected in a newer task revision' WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
          .run(context.environmentId, state.stage, state.updated_at);
        db.prepare("UPDATE worktree_cards SET updated_at = ? WHERE environment_id = ?").run(version, context.environmentId);
      }
      if (!state.active_step_id && task.setup && state.stage !== "design") {
        db.prepare("UPDATE worktree_cards SET active_step_id = ? WHERE environment_id = ?").run(task.setup.steps[0]!.id, context.environmentId);
      }
    })();
    return { taskRevision: revision, task };
  }

  async function startSavedSetup(threadId: string) {
    if (setupAutomation.isPlanner(threadId)) throw new Error("Setup workers cannot dispatch implementation.");
    const context = await currentContext(threadId, false);
    if (context.paused) throw new Error("This worktree is paused.");
    if (!context.activeStep) throw new Error("Save a setup with a step at the current stage first. Design still requires its completion receipt.");
    const launch = readStageThreadLaunch.get(context.environmentId, context.stage, context.stageUpdatedAt) as StageThreadLaunchRow | undefined;
    if (launch?.status === "started") return { threadId: launch.thread_id, status: "started" };
    if (context.ownerThreadId && context.ownerThreadId !== threadId) throw new Error("Only the current owner can start this setup.");
    db.transaction(() => {
      addPendingStageThreadLaunch.run(context.environmentId, context.stage, context.stageUpdatedAt);
      setOwner.run(null, context.environmentId, context.stageUpdatedAt);
    })();
    const worker = await startWorkForStage(context.environmentId, context.stage as StageId, context.stageUpdatedAt, true);
    return { threadId: worker?.id ?? null, status: worker ? "started" : "pending-or-blocked" };
  }

  const automaticDeliverySchema = z.object({ stage: z.enum(["tdd", "quality", "simplify", "pr"]),
    task: taskContextSchema.omit({ setup: true, deliveryStages: true }), }).strict();
  async function deliverAutomatically(threadId: string, input: z.infer<typeof automaticDeliverySchema>) {
    if (setupAutomation.isPlanner(threadId)) throw new Error("A setup worker cannot submit a new delivery request.");
    const worktree = await worktreeForThread(threadId);
    if (setupAutomation.enabled(worktree.environmentId)) return setupAutomation.enqueue(worktree.environmentId, threadId, taskContextSchema.parse(input.task));
    const moved = await moveThreadWorktree(threadId, input.stage, "Automatic delivery requested", "agent");
    if (moved.blockedReason) throw new Error(moved.blockedReason);
    await saveTaskContext(threadId, input.task);
    const job = setupAutomation.enqueue(worktree.environmentId, threadId, taskContextSchema.parse(input.task));
    await setupAutomation.tick(worktree.environmentId);
    return { queued: true, requestId: job.id, instruction: "End this turn. The setup worker will plan and the board will start the task." };
  }
  async function requestPlanRecovery(threadId: string, reason: string) {
    const context = await currentContext(threadId, false);
    if (context.ownerThreadId !== threadId || context.paused) throw new Error("Only the unpaused current worker can request plan recovery.");
    if (context.setupComplete) throw new Error("The saved setup already completed.");
    const interactions = await bb.sdk.threads.interactions.list({ threadId });
    if (interactions.length) throw new Error("Resolve pending input before requesting plan recovery.");
    const job = setupAutomation.recover(context.environmentId, reason);
    return { queued: true, requestId: job.id, instruction: "End this turn without a completion marker. Recovery starts after you are idle." };
  }

  async function setupCatalog(threadId: string, providerId?: string, skillQuery = "") {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no environment for a setup catalog.");
    const [providers, skills, models] = await Promise.all([
      bb.sdk.providers.list({ environmentId: thread.environmentId }),
      bb.sdk.skills.list({ projectId: thread.projectId, environmentId: thread.environmentId }),
      providerId ? bb.sdk.providers.models({ environmentId: thread.environmentId, providerId }) : null,
    ]);
    const matches = skills.skills.filter(skill => (!skill.provider || !providerId || skill.provider === providerId) &&
      `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(skillQuery.toLowerCase()));
    return { providers: providers.map(provider => ({ id: provider.id, name: provider.displayName, available: provider.available })),
      models: models?.models ?? [], modelLoadError: models?.modelLoadError ?? null,
      skills: matches.slice(0, 80).map(({ id, name, description, provider }) => ({ id, name, description, provider })), skillsTruncated: matches.length > 80 };
  }

  function setupPlaybooks(projectId: string | null) {
    if (!projectId) throw new Error("Give a project for checked setup history.");
    return db.prepare("SELECT outcome_json FROM worktree_setup_outcomes WHERE project_id = ? ORDER BY completed_at DESC LIMIT 5")
      .all(projectId).map(value => JSON.parse((value as { outcome_json: string }).outcome_json));
  }

  async function submitCompletion(threadId: string, input: unknown) {
    if (setupAutomation.isPlanner(threadId)) throw new Error("Setup workers cannot submit completion evidence.");
    const evidence = completionEvidenceSchema.parse(input);
    const context = await currentContext(threadId);
    if (context.paused) throw new Error("This worktree is paused.");
    if (context.ownerThreadId !== threadId) throw new Error("Only the assigned stage worker can report completion.");
    if (evidence.stage !== context.stage || evidence.stageUpdatedAt !== context.stageUpdatedAt ||
        evidence.taskRevision !== context.taskRevision || evidence.workspaceDigest !== context.workspaceDigest) {
      throw new Error("Completion is stale. Read current context and rerun checks for the current files.");
    }
    if (!evidence.decisionsResolved || evidence.openFindings.length) throw new Error("Resolve the required decisions and findings before completion.");
    const checks = new Map(evidence.checks.map(check => [check.name, check]));
    if (checks.size !== evidence.checks.length) throw new Error("Check names must be unique.");
    for (const name of context.requiredChecks) {
      if (checks.get(name)?.status !== "passed") throw new Error(`Required check has not passed: ${name}`);
    }
    if (evidence.checks.some(check => !check.evidence.trim() || !["passed", "skipped"].includes(check.status)) ||
        (evidence.stage !== "design" && !evidence.checks.some(check => check.status === "passed"))) {
      throw new Error("Implementation needs passing check evidence. Optional skipped checks need a reason.");
    }
    // Re-read after the host snapshot; a concurrent task or stage change invalidates the result.
    const state = readWorktreeState.get(context.environmentId) as WorktreeStateRow;
    if (state.updated_at !== context.stageUpdatedAt || state.owner_thread_id !== threadId ||
        taskFor(context.environmentId).revision !== context.taskRevision) throw new Error("The task changed while recording completion.");
    db.prepare(`INSERT INTO worktree_stage_results (environment_id, stage_updated_at, thread_id, task_revision, evidence_json, step_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(environment_id, stage_updated_at) DO UPDATE SET thread_id = excluded.thread_id,
      task_revision = excluded.task_revision, evidence_json = excluded.evidence_json`)
      .run(context.environmentId, context.stageUpdatedAt, threadId, context.taskRevision, JSON.stringify(evidence), context.activeStep?.id ?? null);
    db.prepare("UPDATE worktree_stage_thread_launches SET last_error = NULL WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
      .run(context.environmentId, context.stage, context.stageUpdatedAt);
    return { recorded: true, stage: context.stage, stageUpdatedAt: context.stageUpdatedAt };
  }

  function recordSetupOutcome(environmentId: string, summary: string, proof: Record<string, unknown>) {
    const { task, revision } = taskFor(environmentId);
    if (!task?.setup) return false;
    const results = [];
    for (const step of task.setup.steps.filter(step => step.stage !== "pr")) {
      const row = db.prepare(`SELECT r.task_revision, r.evidence_json, v.context_json FROM worktree_stage_results r
        JOIN worktree_task_versions v ON v.environment_id = r.environment_id AND v.revision = r.task_revision
        WHERE r.environment_id = ? AND r.step_id = ? ORDER BY r.stage_updated_at DESC LIMIT 1`)
        .get(environmentId, step.id) as { task_revision: number; evidence_json: string; context_json: string } | undefined;
      if (!row || JSON.stringify(JSON.parse(row.context_json).setup?.steps.find((value: { id: string }) => value.id === step.id)) !== JSON.stringify(step)) return false;
      results.push({ stepId: step.id, taskRevision: row.task_revision, evidence: JSON.parse(row.evidence_json) });
    }
    if (task.setup.steps.at(-1)?.stage === "pr" && !proof.pullRequest) return false;
    const project = db.prepare("SELECT project_id FROM worktree_setup_projects WHERE environment_id = ?").get(environmentId) as { project_id: string } | undefined;
    if (!project) return false;
    db.prepare("INSERT OR IGNORE INTO worktree_setup_outcomes VALUES (?, ?, ?, ?, ?)")
      .run(environmentId, revision, project.project_id, JSON.stringify({ outcome: task.outcome, setup: task.setup, summary, taskRevision: revision, results, ...proof }), Date.now());
    return true;
  }

  const completing = new Set<string>();
  async function advanceCompleted(environmentId: string, threadId: string) {
    if (disposed || paused(environmentId) || completing.has(environmentId)) return;
    completing.add(environmentId);
    try {
      const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
      if (!state || state.owner_thread_id !== threadId) return;
      const row = readResult.get(environmentId, state.updated_at) as { thread_id: string; task_revision: number; evidence_json: string } | undefined;
      if (!row || row.thread_id !== threadId) return;
      const recordProblem = (message: string | null) => db.prepare("UPDATE worktree_stage_thread_launches SET last_error = ? WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .run(message, environmentId, state.stage, state.updated_at);
      if (row.task_revision !== taskFor(environmentId).revision) { recordProblem("Completion evidence belongs to an older task revision."); return; }
      const evidence = completionEvidenceSchema.parse(JSON.parse(row.evidence_json));
      const config = await settings.get();
      if (state.stage === "design" ? !config.autoAdvanceGrilling : !config.autoAdvanceImplementation) return;
      const worker = await bb.sdk.threads.get({ threadId });
      if (hasLiveWork(worker) || (await bb.sdk.threads.interactions.list({ threadId })).length) return;
      if ((await bb.sdk.threads.queuedMessages.list({ threadId })).length) return;
      if (await captureWorkspace(bb.sdk, environmentId) !== evidence.workspaceDigest) {
        recordProblem("Files changed after completion evidence was recorded. Rerun the required checks."); return;
      }
      recordProblem(null);
      const current = readWorktreeState.get(environmentId) as WorktreeStateRow;
      if (current.updated_at !== state.updated_at || current.owner_thread_id !== threadId ||
          taskFor(environmentId).revision !== row.task_revision || paused(environmentId)) return;
      const savedTask = taskFor(environmentId).task;
      const step = savedTask?.setup ? nextSetupStep(savedTask.setup, state.active_step_id) : null;
      const next = savedTask?.setup ? step?.stage : nextDeliveryStage(state.stage, savedTask);
      if (next) await moveWorktree(environmentId, next, evidence.summary, "automation", step?.id);
      else if (savedTask?.setup) recordSetupOutcome(environmentId, evidence.summary, { workspaceDigest: evidence.workspaceDigest });
    } finally { completing.delete(environmentId); }
  }

  let recovery: Promise<void> | undefined;
  async function reconcileWorktrees(options: { force?: boolean; projectId?: string | null } = {}) {
    if (disposed) return;
    if (recovery) return recovery;
    recovery = (async () => {
      await setupAutomation.tickAll();
      const board = await getBoard(options.projectId ?? null);
      const config = await settings.get();
      for (const card of board.cards) {
        if (disposed) break;
        if (paused(card.environmentId)) continue;
        try {
          const state = readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined;
          if (!state || state.updated_at !== card.stageUpdatedAt) continue;
          if (setupAutomation.pending(card.environmentId)) continue;
          const threads = (await listThreads(card.projectId)).filter(thread => thread.environmentId === card.environmentId);
          // A transport failure can hide a successful spawn. Attach its worker even while it runs.
          const request = readStageThreadLaunch.get(card.environmentId, state.stage, state.updated_at) as StageThreadLaunchRow | undefined;
          if (request && ["pending", "starting", "failed", "blocked"].includes(request.status)) {
            const orphan = threads.find(thread => thread.title === launchTitle(card.environmentId, state.stage, state.updated_at));
            if (orphan) {
              saveStageThreadLaunch.run(card.environmentId, state.stage, state.updated_at, "started", orphan.id);
              setOwner.run(orphan.id, card.environmentId, state.updated_at);
              state.owner_thread_id = orphan.id;
            }
          }
          if (threads.some(thread => hasLiveWork(thread) || thread.hasPendingInteraction)) continue;
          let queued = false;
          for (const thread of threads) {
            if ((await bb.sdk.threads.queuedMessages.list({ threadId: thread.id })).length ||
                (await bb.sdk.threads.interactions.list({ threadId: thread.id })).length) { queued = true; break; }
          }
          if (queued || (await bb.sdk.environments.get({ environmentId: card.environmentId })).status !== "ready") continue;
          if (state.stage === "pr") {
            const pr = await bb.sdk.environments.pullRequest({ environmentId: card.environmentId });
            if (pr.outcome === "available" && pr.pullRequest.state === "merged") {
              await moveWorktree(card.environmentId, "done", "Pull request merge verified.", "automation");
              continue;
            }
            if (pr.outcome === "unavailable" || (pr.outcome === "available" && pr.pullRequest.state === "closed")) continue;
          }
          if (setupAutomation.enabled(card.environmentId) && !setupAutomation.exhausted(card.environmentId)) {
            const owner = state.owner_thread_id ? await bb.sdk.threads.get({ threadId: state.owner_thread_id }) : null;
            if (request?.status === "blocked" || owner?.status === "error") {
              setupAutomation.recover(card.environmentId, request?.last_error ?? "The assigned worker failed before completion.");
              await setupAutomation.tick(card.environmentId);
              continue;
            }
          }
          if (state.owner_thread_id) await advanceCompleted(card.environmentId, state.owner_thread_id);
          const current = readWorktreeState.get(card.environmentId) as WorktreeStateRow;
          if (current.updated_at !== state.updated_at) continue;
          // Old requests cannot restart work after an explicit stage change.
          db.prepare(`UPDATE worktree_stage_thread_launches SET status = 'paused', last_error = 'Superseded by a newer stage'
            WHERE environment_id = ? AND status IN ('pending','starting','failed') AND (stage != ? OR stage_updated_at != ?)`)
            .run(card.environmentId, state.stage, state.updated_at);
          const launch = readStageThreadLaunch.get(card.environmentId, state.stage, state.updated_at) as StageThreadLaunchRow | undefined;
          if (!launch || ["started", "blocked", "paused"].includes(launch.status)) continue;
          if (launch.status === "starting") {
            if (stageThreadStarts.has(`${card.environmentId}:${state.stage}`) || launch.updated_at > Date.now() - 120_000) continue;
            const worker = threads.find(thread => thread.title === launchTitle(card.environmentId, state.stage, state.updated_at));
            if (worker) {
              saveStageThreadLaunch.run(card.environmentId, state.stage, state.updated_at, "started", worker.id);
              setOwner.run(worker.id, card.environmentId, state.updated_at);
              continue;
            }
            if (launch.attempt_count === 0) {
              db.prepare(`UPDATE worktree_stage_thread_launches SET status = 'blocked', last_error = 'Legacy start has an uncertain result; inspect before retry'
                WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?`).run(card.environmentId, state.stage, state.updated_at);
              continue;
            }
            db.prepare(`UPDATE worktree_stage_thread_launches SET status = 'failed', next_attempt_at = 0,
              last_error = 'Start lease expired; no matching worker exists' WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?`)
              .run(card.environmentId, state.stage, state.updated_at);
          }
          if (state.stage !== "pr" && !config.autoAdvanceImplementation) continue;
          if (state.stage === "pr" && config.simplifyToPrMode !== "auto") continue;
          if (options.force && launch.status === "failed") {
            db.prepare("UPDATE worktree_stage_thread_launches SET next_attempt_at = 0 WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
              .run(card.environmentId, state.stage, state.updated_at);
          }
          await startWorkForStage(card.environmentId, state.stage as StageId, state.updated_at);
        } catch (error) {
          bb.log.error(`Recovery for ${card.environmentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    try { await recovery; } finally { recovery = undefined; }
  }

  async function health(projectId: string | null) {
    const board = await getBoard(projectId);
    return (await Promise.all(board.cards.map(async card => {
      const launch = readStageThreadLaunch.get(card.environmentId, card.stage, card.stageUpdatedAt) as StageThreadLaunchRow | undefined;
      const setupJob = setupAutomation.latest(card.environmentId);
      if (!paused(card.environmentId) && setupJob && ["pending", "starting", "started", "blocked"].includes(setupJob.status)) {
        if (setupJob.status === "started" && setupJob.thread_id && !setupJob.last_error) {
          const planner = await bb.sdk.threads.get({ threadId: setupJob.thread_id }).catch(() => null);
          if (planner && hasLiveWork(planner) && !card.hasPendingInteraction &&
              !(await bb.sdk.threads.interactions.list({ threadId: planner.id })).length) return [];
        }
        return [{ environmentId: card.environmentId, projectId: card.projectId, stage: card.stage, stageUpdatedAt: card.stageUpdatedAt,
          status: `setup-${setupJob.status}`, attempts: setupJob.attempts, error: setupJob.last_error,
          waitingForInput: card.hasPendingInteraction, hasLiveWork: card.status === "active" }];
      }
      if (paused(card.environmentId) || !launch || launch.status === "paused") return [];
      let status: string = launch.status;
      let error = launch.last_error;
      if (launch.status === "started") {
        const owner = launch.thread_id ? await bb.sdk.threads.get({ threadId: launch.thread_id }).catch(() => null) : null;
        if (!owner || owner.deletedAt || owner.archivedAt || owner.environmentId !== card.environmentId) { status = "worker-unavailable"; error = "The assigned worker is unavailable. Inspect it before resuming work."; }
        else if (owner.status === "error") { status = "worker-failed"; error ??= "The stage worker failed. Inspect its failure before retrying."; }
        else if ((await bb.sdk.threads.interactions.list({ threadId: owner.id })).length) { status = "waiting-for-decision"; error ??= "The stage worker has a pending question or approval."; }
        else if (hasLiveWork(owner) || (await bb.sdk.threads.queuedMessages.list({ threadId: owner.id })).length) return [];
        else if (error) status = "evidence-stale";
        else if (card.stage !== "pr" && !readResult.get(card.environmentId, card.stageUpdatedAt)) {
          status = "evidence-needed"; error = "The worker is idle without completion evidence. It may have been stopped; no automatic restart was attempted.";
        } else return [];
      }
      return [{ environmentId: card.environmentId, projectId: card.projectId, stage: card.stage,
        stageUpdatedAt: card.stageUpdatedAt, status, attempts: launch.attempt_count,
        error, waitingForInput: card.hasPendingInteraction, hasLiveWork: card.status === "active" }];
    }))).flat();
  }

  async function getBoard(projectId: string | null) {
    const [threads, projects, lifecycle] = await Promise.all([
      listThreads(projectId ?? undefined),
      bb.sdk.projects.list({ includePersonal: true }),
      readT3Lifecycle(),
    ]);
    const projectNames = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const states = new Map(
      (readAllWorktreeStates.all() as WorktreeStateRow[]).map((row) => [
        row.environment_id,
        row,
      ]),
    );
    const legacyStates = new Map(
      (readAllLegacyStates.all() as LegacyCardStateRow[]).map((row) => [
        row.thread_id,
        row,
      ]),
    );
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const settledAtByThread = new Map(
      lifecycle.rows.flatMap((row) =>
        row.settledAt === null ? [] : [[row.threadId, row.settledAt] as const],
      ),
    );
    const isSettled = (thread: ThreadRow) => {
      const settledAt = settledAtByThread.get(thread.id);
      if (settledAt === undefined) return false;
      if (thread.hasPendingInteraction || hasLiveWork(thread)) return false;
      return (thread.latestAttentionAt ?? thread.updatedAt) <= settledAt;
    };
    const groups = new Map<string, ThreadRow[]>();
    for (const thread of threads) {
      if (!isWorktreeThread(thread) || isSettled(thread)) continue;
      const rows = groups.get(thread.environmentId!) ?? [];
      rows.push(thread);
      groups.set(thread.environmentId!, rows);
    }

    const rootId = (thread: ThreadRow) => {
      let current = thread;
      const seen = new Set<string>();
      while (current.parentThreadId) {
        if (seen.has(current.id)) break;
        seen.add(current.id);
        const parent = threadById.get(current.parentThreadId);
        if (!parent) break;
        current = parent;
      }
      return current.id;
    };

    const cards = [...groups.entries()]
      .map(([environmentId, rows]) => {
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        const lead = rows[0]!;
        const legacy = rows
          .map((thread) => legacyStates.get(rootId(thread)))
          .filter((state): state is LegacyCardStateRow => Boolean(state))
          .sort((a, b) => b.updated_at - a.updated_at)[0];
        const worktreeState = states.get(environmentId);
        const saved = worktreeState ?? legacy;
        if (!worktreeState && legacy && isStageId(legacy.stage)) {
          saveWorktreeState.run(
            environmentId,
            legacy.stage,
            legacy.note,
            legacy.updated_at,
          );
          states.set(environmentId, {
            environment_id: environmentId,
            stage: legacy.stage,
            note: legacy.note,
            updated_at: legacy.updated_at,
          });
        }
        const stage =
          saved && isStageId(saved.stage) ? saved.stage : DEFAULT_STAGE;
        const launch = readStageThreadLaunch.get(
          environmentId,
          stage,
          saved?.updated_at ?? 0,
        ) as StageThreadLaunchRow | undefined;
        return {
          environmentId,
          projectId: lead.projectId,
          projectName: projectNames.get(lead.projectId) ?? "Unknown project",
          worktreeName:
            lead.environmentName ??
            lead.environmentBranchName ??
            "Unnamed worktree",
          branchName: lead.environmentBranchName,
          stage,
          note: saved?.note ?? null,
          status: worktreeStatus(rows),
          hasPendingInteraction: rows.some(
            (thread) => thread.hasPendingInteraction === true,
          ),
          updatedAt: Math.max(...rows.map((thread) => thread.updatedAt)),
          stageUpdatedAt: saved?.updated_at ?? Math.min(...rows.map((thread) => thread.createdAt)),
          pendingThreadStart:
            launch?.status === "pending"
              ? { stage, label: stage === "pr" ? "Start PR thread" : `Start ${stageLabel(stage)} thread` }
              : null,
          threads: rows.map((thread) => ({
            id: thread.id,
            title: displayTitle(thread),
            status: thread.status,
            updatedAt: thread.updatedAt,
            parentThreadId: thread.parentThreadId,
            hasPendingInteraction: thread.hasPendingInteraction === true,
          })),
        };
      })
      .sort((a, b) => b.stageUpdatedAt - a.stageUpdatedAt);

    return { stages: [...STAGES], cards };
  }

  bb.rpc.register(rpcContract, {
    getBoard: ({ projectId }) => getBoard(projectId),
    moveCard: ({ environmentId, stage, note }) =>
      moveWorktree(environmentId, stage, note, "panel"),
    createThread: async ({ request }) => {
      const thread = await bb.sdk.threads.spawn(request);
      return { threadId: thread.id };
    },
    getComposerDefaults: async ({ threadId }) => {
      const [thread, execution] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        bb.sdk.threads.defaultExecutionOptions({ threadId }),
      ]);
      return {
        providerId: thread.providerId,
        ...(execution
          ? {
              model: execution.model,
              serviceTier: execution.serviceTier,
              reasoningLevel: execution.reasoningLevel,
              permissionMode: execution.permissionMode,
            }
          : {}),
      };
    },
    startStageThread: async ({ environmentId }) => {
      const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
      if (!state || state.stage !== "pr") throw new Error("This Git Worktree has no PR thread to start.");
      const thread = await startWorkForStage(environmentId, "pr", state.updated_at, true);
      if (!thread) throw new Error("This PR thread has already started or the worktree is paused.");
      bb.realtime.publish("board-changed", { environmentId, stage: state.stage });
      return { threadId: thread.id };
    },
  });

  bb.agents.registerTool({
    name: "workflow_board_move_card",
    description:
      "Assign the current Git worktree card to the stage that matches the work now being done. All threads in the worktree share the stage.",
    instructions:
      "Assign the stage that matches the current work. Keep a Worktree Card in design until the user moves it to TDD or the design thread reports [workflow:grilling-complete]. Assign review for /code-review work. It reports findings on external changes and makes no code changes. Use quality only for the internal review-and-fix loop. Do not step through skipped stages. For example, assign pr directly for PR creation or /babysit-pr work. This assignment never starts earlier workflow work. Use done only after the pull request has merged.",
    presentation: {
      label: {
        pending: "Moving the worktree card",
        completed: "Moved the worktree card",
      },
    },
    parameters: z.object({
      stage: stageSchema.describe(
        "The new stage: tickets, design, tdd, quality, simplify, review, pr, or done.",
      ),
      note: z.string().trim().max(500).optional().describe("A short reason or status note."),
      threadId: z
        .string()
        .optional()
        .describe("A thread in the worktree to move. Omit this for the current thread."),
    }),
    async execute({ stage, note, threadId }, context) {
      if (setupAutomation.isPlanner(context.threadId)) throw new Error("Setup workers cannot move board cards.");
      const result = await moveThreadWorktree(
        threadId ?? context.threadId,
        stage,
        note,
        "agent",
      );
      if (result.blockedReason) return result.blockedReason;
      return `Moved worktree ${result.worktreeName} to ${stageLabel(stage)}.`;
    },
  });

  bb.agents.registerTool({
    name: "workflow_board_get_context",
    description: "Read this worktree's saved task, assigned stage worker, task revision, stage revision, and current file digest before completing work.",
    parameters: z.object({}),
    async execute(_input, context) { return JSON.stringify(await currentContext(context.threadId)); },
  });
  bb.agents.registerTool({
    name: "workflow_board_set_task",
    description: "Save the existing authorized outcome, scope, accepted decisions, required checks, and allowed actions for this worktree. Reuse decisions while their scope still applies.",
    parameters: taskContextSchema,
    async execute(input, context) { return JSON.stringify(await saveTaskContext(context.threadId, input)); },
  });
  bb.agents.registerTool({
    name: "workflow_board_complete_stage",
    description: "Record completion evidence for the assigned Design, TDD, Quality, or Simplify stage. Read current context after the last file change and check. Then finish with the exact stage marker on its own line; the board starts the next stage after this worker is idle.",
    parameters: completionEvidenceSchema,
    async execute(input, context) { return JSON.stringify(await submitCompletion(context.threadId, input)); },
  });

  bb.agents.registerTool({
    name: "workflow_board_start",
    description: "Start the saved setup's current step once. The board uses its saved harness, model, effort and selected skill references. A pause or Design Gate blocks dispatch.",
    parameters: z.object({}),
    async execute(_input, context) { return JSON.stringify(await startSavedSetup(context.threadId)); },
  });
  bb.agents.registerTool({
    name: "workflow_board_catalog",
    description: "Inspect installed harnesses, exact available models and effort levels, and relevant skills before choosing a task setup. Give providerId to read models and skillQuery to narrow skills.",
    parameters: z.object({ providerId: z.string().max(128).optional(), skillQuery: z.string().max(160).optional() }),
    async execute(input, context) { return JSON.stringify(await setupCatalog(context.threadId, input.providerId, input.skillQuery)); },
  });
  bb.agents.registerTool({
    name: "workflow_board_playbooks",
    description: "Read recent checked setups in this project as starting points for a new task. Prior results never grant authority or validate new work.",
    parameters: z.object({}),
    async execute(_input, context) { return JSON.stringify(setupPlaybooks(context.projectId)); },
  });

  bb.agents.registerTool({ name: "workflow_board_deliver", description: "Submit the authorized task once. The board saves it, plans from live catalogs, validates the setup, and starts work after this thread is idle. Design and pause gates remain in force.",
    parameters: automaticDeliverySchema,
    async execute(input, context) { return JSON.stringify(await deliverAutomatically(context.threadId, input)); },
  });
  bb.agents.registerTool({ name: "workflow_board_apply_setup", description: "Assigned setup worker only: validate and save the setup proposal. The board retains the authorized task and dispatches after this worker is idle.",
    parameters: setupProposalSchema,
    async execute(input, context) { return JSON.stringify(await setupAutomation.apply(context.threadId, input.setup)); },
  });
  bb.agents.registerTool({ name: "workflow_board_recover", description: "Current worker only: request a bounded plan change after a technical failure. Preserve scope and checks. End the turn; the setup worker replans after you are idle. Never use for pending human decisions.",
    parameters: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(),
    async execute(input, context) { return JSON.stringify(await requestPlanRecovery(context.threadId, input.reason)); },
  });

  bb.agents.configure(context => setupAutomation.isPlanner(context.thread.id, context.thread.title) ? {
    tools: ["workflow_board_apply_setup", "workflow_board_catalog", "workflow_board_get_context"], skills: [],
    instructions: "You are the assigned setup worker. Submit a plan through workflow_board_apply_setup. Read context and catalog as needed. Do not implement, move stages, dispatch, change task authority, or complete work.",
  } : ({
    tools: ["workflow_board_move_card", "workflow_board_get_context", "workflow_board_set_task", "workflow_board_complete_stage", "workflow_board_start", "workflow_board_catalog", "workflow_board_playbooks", "workflow_board_deliver", "workflow_board_recover"],
    skills: [],
    instructions:
      "For normal Git worktree delivery, use the delivery skill when available. Honor explicit workflow opt-outs before board access. Keep the worktree stage current. Assign the stage that matches the work this thread is doing now; do not step through work that this task does not need. Keep a Worktree Card in design until the user moves it to TDD or the design thread reports [workflow:grilling-complete]. Planning implementation does not finish Design. Assign review for /code-review work. It reports findings on external changes and makes no code changes. Code Review is outside Implementation and starts no later work. Assign tdd for /tdd work that starts outside Design, quality only for the internal /thermo-nuclear-code-quality-review fix loop, simplify for /simplify, and pr for PR creation or /babysit-pr. Stage assignment does not start skipped work. Use done only after the pull request has merged. Read workflow_board_get_context and submit workflow_board_complete_stage with current revision and check evidence before completing Design or Implementation. A text marker alone does not advance a card. Reuse saved scope and accepted decisions across handoffs. For new authorized tasks, submit workflow_board_deliver with the task and target stage once, then end this turn. The board owns setup and dispatch. For an existing worker, use its saved setup. After a technical failure, workflow_board_recover can request a bounded plan change; never use it for a pending human decision. The board owns all later dispatch. Adapt remaining steps when findings change the needed work. Report completion with one exact final standalone marker: [workflow:grilling-complete], [workflow:tdd-complete], [workflow:quality-clear], or [workflow:simplify-complete].",
  }));

  bb.cli.register({
    name: "workflow-board",
    summary: "Read and move worktree cards",
    commands: [
      { name: "deliver", summary: "Plan and run an authorized task", usage: "bb workflow-board deliver '<json>'" },
      { name: "apply-setup", summary: "Submit the assigned setup proposal", usage: "bb workflow-board apply-setup '<json>'" },
      { name: "recover", summary: "Request bounded plan recovery", usage: "bb workflow-board recover <reason>" },
      { name: "start", summary: "Start the saved setup step once", usage: "bb workflow-board start" },
      { name: "catalog", summary: "Read live setup choices", usage: "bb workflow-board catalog [provider-id] [skill-query]" },
      { name: "playbooks", summary: "Read recent checked setups", usage: "bb workflow-board playbooks [project-id]" },
      { name: "history", summary: "Read saved task revisions", usage: "bb workflow-board history" },
      { name: "show", summary: "Show worktree stages", usage: "bb workflow-board show [project-id]" },
      { name: "move", summary: "Move the worktree for a thread", usage: "bb workflow-board move <stage> [thread-id] [note]" },
      { name: "snapshot", summary: "Read the current worktree file digest", usage: "bb workflow-board snapshot <environment-id>" },
      { name: "context", summary: "Read saved task and current file revision", usage: "bb workflow-board context" },
      { name: "task", summary: "Save the authorized work request", usage: "bb workflow-board task '<json>'" },
      { name: "complete", summary: "Record checked stage completion", usage: "bb workflow-board complete '<json>'" },
      { name: "health", summary: "Read pending and failed launches as JSON", usage: "bb workflow-board health [project-id]" },
      { name: "reconcile", summary: "Recover eligible stage launches and check merged PRs", usage: "bb workflow-board reconcile [project-id]" },
      { name: "pause", summary: "Pause automatic work for a worktree", usage: "bb workflow-board pause [environment-id]" },
      { name: "resume", summary: "Resume automatic work for a worktree", usage: "bb workflow-board resume [environment-id]" },
      { name: "stages", summary: "List valid stages", usage: "bb workflow-board stages" },
    ],
    async run(argv, context) {
      const [command, ...args] = argv;
      if (["deliver", "apply-setup", "recover"].includes(command ?? "")) {
        if (!context.threadId) return { exitCode: 2, stderr: "Run this command in its task thread.\n" };
        const result = command === "deliver" ? await deliverAutomatically(context.threadId, automaticDeliverySchema.parse(JSON.parse(args.join(" "))))
          : command === "apply-setup" ? await setupAutomation.apply(context.threadId, setupProposalSchema.parse(JSON.parse(args.join(" "))).setup)
          : await requestPlanRecovery(context.threadId, z.string().trim().min(1).max(2000).parse(args.join(" ")));
        return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
      }
      if (command === "playbooks") return { exitCode: 0, stdout: `${JSON.stringify(setupPlaybooks(args[0] ?? context.projectId))}\n` };
      if (["start", "catalog", "history"].includes(command ?? "")) {
        if (!context.threadId) return { exitCode: 2, stderr: "Run this command in a task thread.\n" };
        const result = command === "start" ? await startSavedSetup(context.threadId) : command === "catalog"
          ? await setupCatalog(context.threadId, args[0], args.slice(1).join(" "))
          : db.prepare("SELECT revision, context_json, created_at FROM worktree_task_versions WHERE environment_id = ? ORDER BY revision DESC LIMIT 10")
            .all((await worktreeForThread(context.threadId)).environmentId).map(value => { const row = value as { revision: number; context_json: string; created_at: number }; const task = JSON.parse(row.context_json); return { revision: row.revision, createdAt: row.created_at, outcome: task.outcome, setup: task.setup ?? null }; });
        return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
      }
      if (command === "snapshot") {
        if (!args[0]) return { exitCode: 2, stderr: "Give a worktree environment ID.\n" };
        return { exitCode: 0, stdout: `${JSON.stringify({ environmentId: args[0], workspaceDigest: await captureWorkspace(bb.sdk, args[0]) })}\n` };
      }
      if (["context", "task", "complete"].includes(command ?? "")) {
        if (!context.threadId) return { exitCode: 2, stderr: "Run this command in the assigned worker thread.\n" };
        const result = command === "context" ? await currentContext(context.threadId)
          : command === "task" ? await saveTaskContext(context.threadId, JSON.parse(args.join(" ")))
          : await submitCompletion(context.threadId, JSON.parse(args.join(" ")));
        return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
      }
      if (command === "health") return { exitCode: 0, stdout: `${JSON.stringify(await health(args[0] ?? context.projectId ?? null))}\n` };
      if (command === "reconcile") { await reconcileWorktrees({ force: true, projectId: args[0] ?? context.projectId }); return { exitCode: 0, stdout: "Reconciliation complete.\n" }; }
      if (command === "pause" || command === "resume") {
        const environmentId = args[0] ?? (context.threadId ? (await worktreeForThread(context.threadId)).environmentId : undefined);
        if (!environmentId) return { exitCode: 2, stderr: "Give a worktree environment ID.\n" };
        await bb.sdk.environments.get({ environmentId });
        db.prepare(`INSERT INTO worktree_controls VALUES (?, ?) ON CONFLICT(environment_id) DO UPDATE SET paused = excluded.paused`)
          .run(environmentId, command === "pause" ? 1 : 0);
        if (command === "resume") await reconcileWorktrees();
        return { exitCode: 0, stdout: `${command === "pause" ? "Paused" : "Resumed"} ${environmentId}.\n` };
      }

      if (command === "stages") {
        return { exitCode: 0, stdout: `${STAGES.map((stage) => `${stage.id}\t${stage.label}`).join("\n")}\n` };
      }
      if (command === "show") {
        const board = await getBoard(args[0] ?? context.projectId ?? null);
        const text = STAGES.flatMap((stage) => {
          const cards = board.cards.filter((card) => card.stage === stage.id);
          return [
            `${stage.label} (${cards.length})`,
            ...cards.map((card) => `  ${card.environmentId}\t${card.worktreeName}\t${card.threads.length} threads`),
          ];
        }).join("\n");
        return { exitCode: 0, stdout: `${text}\n` };
      }
      if (command === "move") {
        if (context.threadId && setupAutomation.isPlanner(context.threadId)) throw new Error("Setup workers cannot move board cards.");
        const [stageArg, threadArg, ...noteParts] = args;
        if (!stageArg || !isStageId(stageArg)) {
          return { exitCode: 2, stderr: `Stage must be one of: ${STAGE_IDS.join(", ")}.\n` };
        }
        const threadId = threadArg ?? context.threadId;
        if (!threadId) {
          return { exitCode: 2, stderr: "Give a thread ID or run this command in a thread.\n" };
        }
        const result = await moveThreadWorktree(
          threadId,
          stageArg,
          noteParts.length > 0 ? noteParts.join(" ") : undefined,
          context.threadId ? "agent" : "cli",
        );
        if (result.blockedReason) return { exitCode: 2, stderr: `${result.blockedReason}\n` };
        return { exitCode: 0, stdout: `Moved ${result.worktreeName} to ${stageLabel(stageArg)}.\n` };
      }
      return { exitCode: 2, stderr: "Usage: bb workflow-board <show | move | context | task | complete | start | catalog | playbooks | history | health | reconcile | pause | resume | snapshot | stages>\n" };
    },
  });

  const publishThreadChange = ({ thread }: { thread: { id: string } }) => {
    bb.realtime.publish("board-changed", { threadId: thread.id });
  };
  bb.events.on("thread.created", publishThreadChange);
  bb.events.on("thread.active", publishThreadChange);
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    publishThreadChange({ thread });
    if (thread.environmentId && setupAutomation.enabled(thread.environmentId)) await reconcileWorktrees();
    if (!lastAssistantText) return;
    const completion = reportedCompletionTransition(lastAssistantText);
    if (!completion) return;
    try {
      const { environmentId } = await worktreeForThread(thread.id);
      const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
      if (!state || completion.sourceStage !== state.stage || state.owner_thread_id !== thread.id) return;
      await advanceCompleted(environmentId, thread.id);
    } catch (error) {
      bb.log.error(`Completion handling failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bb.events.on("thread.failed", async ({ thread }) => {
    publishThreadChange({ thread });
    if (thread.environmentId && setupAutomation.enabled(thread.environmentId)) await reconcileWorktrees();
  });
  bb.events.on("thread.archived", publishThreadChange);
  bb.events.on("thread.deleted", publishThreadChange);

  bb.background.service("workflow-recovery", { async start(signal) {
    if (!signal.aborted) await reconcileWorktrees();
  } });
  bb.background.schedule("reconcile-worktrees", "*/5 * * * *", () => reconcileWorktrees());
  settings.onChange(() => {
    if (!disposed) void reconcileWorktrees().catch(error => bb.log.error(`Settings recovery failed: ${String(error)}`));
  });
  bb.log.info("Workflow Board loaded");
}
