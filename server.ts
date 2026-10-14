import {
  defineRpcContract,
  type BbPluginApi,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { captureWorkspace, completionEvidenceSchema, taskContextSchema } from "./stage-evidence";
import { nextDeliveryStage, requiredStageChecks } from "./delivery-plan";
import { activeSetupStep, nextSetupStep, normalizeLegacyDeliveryStages, preserveCompletedSteps, requirePrWatch, validateSetupRevision } from "./setup-plan";
import { resolveStepExecution } from "./step-execution";
import { validateKindSteps } from "./task-kinds";
import { createSetupAutomation, setupAutomationMigration } from "./setup-automation";
import { createThreadRetry, threadRetryMigration } from "./thread-retry";
import { createStageContinuation, stageContinuationMigration } from "./stage-continuation";
import { createTddRepair, tddRepairMigration } from "./tdd-repair";
import { buildStagePrompt, DEFAULT_STAGE_PROMPTS } from "./stage-prompts";
import { setupProposalSchema } from "./setup-request";
import { sidebar, sidebarMigrations } from "./sidebar/server";
import { importMigration, importOldData } from "./import-data";
import {
  DEFAULT_STAGE,
  STAGE_IDS,
  STAGES,
  isStageId,
  reportedCompletionTransition,
  stageLabel,
  type StageId,
} from "./workflow";

const stageSchema = z.enum(STAGE_IDS);
const PLUGIN_SKILLS = ["babysit-pr", "benchmark-checklist", "code-review", "codebase-design", "delivery", "diagnosing-bugs", "grilling", "ponytail",
  "principle-fix-root-causes", "principle-migrate-callers-then-delete-legacy-apis", "principle-minimize-reader-load", "principle-model-the-domain",
  "principle-sequence-verifiable-units", "principle-subtract-before-you-add", "principle-test-behavior-not-implementation", "show-me", "simplify", "tdd",
  "thermo-nuclear-code-quality-review"] as const;
const threadStatusSchema = z.enum([
  "error",
  "pending",
  "stopping",
  "idle",
  "starting",
  "active",
]);

const workThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: threadStatusSchema,
  updatedAt: z.number(),
  parentThreadId: z.string().nullable(),
  hasPendingInteraction: z.boolean(),
  canSettle: z.boolean(),
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
  settleThread: {
    input: z.object({ threadId: z.string().trim().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
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
    startInDesign: { type: "boolean", label: "Wait in Design before automatic delivery", default: true },
    useInitiatingThread: { type: "boolean", label: "Use the initiating thread as orchestrator", default: true },
    orchestratorProviderId: { type: "string", label: "Preferred orchestrator provider", default: "" },
    orchestratorModel: { type: "string", label: "Preferred orchestrator model", default: "" },
    orchestratorReasoningLevel: { type: "select", label: "Preferred orchestrator reasoning (auto lets the orchestrator choose)", options: ["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode", "none"], default: "auto" },
    tddReasoningLevel: { type: "select", label: "Preferred TDD reasoning (auto lets the orchestrator choose)", options: ["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode", "none"], default: "auto" },
    reviewReasoningLevel: { type: "select", label: "Preferred Quality reasoning (auto lets the orchestrator choose)", options: ["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode", "none"], default: "auto" },
    simplifyReasoningLevel: { type: "select", label: "Preferred Simplify reasoning (auto lets the orchestrator choose)", options: ["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode", "none"], default: "auto" },
    prReasoningLevel: { type: "select", label: "Preferred PR Watch reasoning (auto lets the orchestrator choose)", options: ["auto", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode", "none"], default: "auto" },
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
      label: "Preferred TDD provider (blank lets the orchestrator choose)",
      default: "",
    },
    tddModel: {
      type: "string",
      label: "Preferred TDD model (blank lets the orchestrator choose)",
      default: "",
    },
    tddPrompt: {
      type: "string",
      label: "TDD prompt",
      default: DEFAULT_STAGE_PROMPTS.tdd,
    },
    reviewProviderId: {
      type: "string",
      label: "Preferred Quality provider (blank lets the orchestrator choose)",
      default: "",
    },
    reviewModel: {
      type: "string",
      label: "Preferred Quality model (blank lets the orchestrator choose)",
      default: "",
    },
    reviewPrompt: {
      type: "string",
      label: "Quality review prompt",
      default: DEFAULT_STAGE_PROMPTS.quality,
    },
    simplifyProviderId: {
      type: "string",
      label: "Preferred Simplify provider",
      default: "claude-code",
    },
    simplifyModel: {
      type: "string",
      label: "Preferred Simplify model",
      default: "claude-fable-5-1",
    },
    simplifyPrompt: {
      type: "string",
      label: "Simplify prompt",
      default: DEFAULT_STAGE_PROMPTS.simplify,
    },
    simplifyToPrMode: {
      type: "select",
      label: "Simplify to PR thread",
      options: ["ask", "auto"],
      default: "auto",
    },
    prProviderId: {
      type: "string",
      label: "Preferred PR Watch provider",
      default: "codex",
    },
    prModel: {
      type: "string",
      label: "Preferred PR Watch model",
      default: "gpt-5.6-sol",
    },
    prPrompt: {
      type: "string",
      label: "PR prompt",
      default: DEFAULT_STAGE_PROMPTS.pr,
    },
  });
  async function modelPreferences() {
    const config = await settings.get();
    const choice = (providerId: string, model: string, reasoningLevel: string) => ({
      providerId: providerId.trim() || null, model: model.trim() || null,
      ...(reasoningLevel && reasoningLevel !== "auto" ? { reasoningLevel } : {}),
    });
    return {
      modelMap: {
        orchestrator: choice(config.orchestratorProviderId, config.orchestratorModel, config.orchestratorReasoningLevel),
        tdd: choice(config.tddProviderId, config.tddModel, config.tddReasoningLevel),
        quality: choice(config.reviewProviderId, config.reviewModel, config.reviewReasoningLevel),
        simplify: choice(config.simplifyProviderId, config.simplifyModel, config.simplifyReasoningLevel),
        pr: choice(config.prProviderId, config.prModel, config.prReasoningLevel),
      },
      modelSelectionPolicy: "These are preferences, not fixed choices. Validate against the live catalog. Choose effort and skills for the task. The board uses these provider/model/effort preferences unless execution.modelOverrideReason explains why another choice fits this task better. execution.reason alone does not override a preference. Blank preferences leave the choice to the orchestrator. Settings apply to future planning; keep running workers and completed steps unchanged.",
    };
  }
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
    `CREATE TABLE worktree_blocked_attempts (
      environment_id TEXT PRIMARY KEY, stage_updated_at INTEGER NOT NULL,
      task_revision INTEGER NOT NULL, thread_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL
    );`,
    threadRetryMigration,
    tddRepairMigration,
    stageContinuationMigration,
    ...sidebarMigrations,
    importMigration,
  ]);
  const sidebarState = sidebar(bb, db, {
    preferredMains: () => db.prepare("SELECT p.project_id AS projectId, r.environment_id AS environmentId, r.initiator_thread_id AS threadId FROM worktree_delivery_runs r JOIN worktree_setup_projects p ON p.environment_id = r.environment_id").all() as Array<{ projectId: string; environmentId: string; threadId: string }>,
    titleChoice: () => null,
  });

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
  const threadRetry = createThreadRetry(bb, db, () => disposed);
  const stageContinuation = createStageContinuation(bb, db, () => disposed);
  const tddRepair = createTddRepair(bb, db, () => disposed);
  const setupAutomation = createSetupAutomation(bb, db, {
    modelPreferences,
    useInitiatingThread: async () => (await settings.get()).useInitiatingThread,
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
      normalizeLegacyDeliveryStages(task);
      const revision = saved.revision + 1;
      const version = Math.max(Date.now(), state.updated_at + 1);
      const activeId = request.kind !== "recovery" ? plan.steps[0]!.id : state.active_step_id;
      db.prepare("UPDATE worktree_task_contexts SET revision = ?, context_json = ? WHERE environment_id = ?").run(revision, JSON.stringify(task), request.environment_id);
      db.prepare("INSERT INTO worktree_task_versions VALUES (?, ?, ?, ?)").run(request.environment_id, revision, JSON.stringify(task), Date.now());
      db.prepare("UPDATE worktree_stage_thread_launches SET status = 'paused', last_error = 'Replaced by a validated setup revision' WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .run(request.environment_id, state.stage, state.updated_at);
      db.prepare("UPDATE worktree_cards SET updated_at = ?, active_step_id = ?, owner_thread_id = NULL WHERE environment_id = ?")
        .run(version, activeId, request.environment_id);
      addPendingStageThreadLaunch.run(request.environment_id, state.stage, version);
      addWorktreeHistory.run(request.environment_id, state.stage, request.kind === "initial" ? "Automatic setup accepted" : "Bounded plan recovery accepted", "automation", version);
    },
    listThreads: projectId => listThreads(projectId),
    hasLiveWork,
    retryThread: threadRetry.retry,
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

  async function startStageThread(
    environmentId: string,
    requested: { providerId: string; model: string; prompt: string },
    stage?: StageId,
    stageUpdatedAt?: number,
  ) {
    const environment = await bb.sdk.environments.get({ environmentId });
    const usableParent = (thread: { environmentId?: string | null; projectId: string; archivedAt?: number | null; deletedAt?: number | null } | null | undefined) =>
      Boolean(thread && thread.environmentId === environmentId && thread.projectId === environment.projectId && !thread.archivedAt && !thread.deletedAt);
    const threads = (await listThreads(environment.projectId))
      .filter(usableParent)
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
        }).catch(() => null));
      if (!parent || !usableParent(parent)) break;
      seen.add(parent.id);
      mainThread = parent;
    }
    const orchestratorId = setupAutomation.orchestrator(environmentId);
    const orchestrator = orchestratorId
      ? await bb.sdk.threads.get({ threadId: orchestratorId }).catch(() => null)
      : null;
    const parentThreadId = orchestrator && usableParent(orchestrator) ? orchestrator.id : mainThread.id;
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
      selected = prior?.execution_json ? JSON.parse(prior.execution_json) : await resolveStepExecution(bb.sdk, { environmentId, projectId: environment.projectId }, step.execution, (await modelPreferences()).modelMap[step.stage]);
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

    const previous = db.prepare("SELECT thread_id FROM worktree_stage_results WHERE environment_id = ? ORDER BY stage_updated_at DESC LIMIT 1")
      .get(environmentId) as { thread_id: string } | undefined;
    if (disposed || paused(environmentId) || taskFor(environmentId).revision !== savedRevision || (stageUpdatedAt !== undefined &&
        (readWorktreeState.get(environmentId) as WorktreeStateRow | undefined)?.updated_at !== stageUpdatedAt)) {
      throw new Error("The stage changed or paused before worker dispatch.");
    }
    return bb.sdk.threads.spawn({
      visibility: "visible",
      ...(stage !== undefined && stageUpdatedAt !== undefined ? { title: launchTitle(environmentId, stage, stageUpdatedAt) } : {}),
      projectId: environment.projectId,
      parentThreadId,
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
      prompt: buildStagePrompt({
        stage: stage ?? stageSchema.parse(state?.stage ?? "tdd"), prompt: requested.prompt, environmentId,
        stageUpdatedAt: stageUpdatedAt ?? state?.updated_at, taskRevision: savedRevision,
        activeStepId: step?.id ?? null, previousThreadId: previous?.thread_id ?? sourceThread.id,
      }),
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
    if (setupAutomation.pending(environmentId)) return null;
    if (blockedAttempt(environmentId)) throw new Error("Recorded checks are blocked; do not restart the same stage. Read context for the evidence.");
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
        providerId: config.simplifyProviderId,
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
        prompt: config.prPrompt,
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
    if (old?.stage === "design" && stage === "tdd" && setupAutomation.enabled(environmentId) && !setup) {
      setupAutomation.openDesignGate(environmentId);
      await setupAutomation.tick(environmentId);
    } else if (shouldStart) await startWorkForStage(environmentId, stage, now);
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

  function blockedAttempt(environmentId: string) {
    const state = readWorktreeState.get(environmentId) as WorktreeStateRow | undefined;
    const row = db.prepare("SELECT * FROM worktree_blocked_attempts WHERE environment_id = ?").get(environmentId) as {
      stage_updated_at: number; task_revision: number; thread_id: string; evidence_json: string; reason: string; recorded_at: number;
    } | undefined;
    if (!row || row.stage_updated_at !== state?.updated_at || row.task_revision !== taskFor(environmentId).revision ||
        row.thread_id !== state.owner_thread_id) return null;
    return { reason: row.reason, recordedAt: row.recorded_at, evidence: completionEvidenceSchema.parse(JSON.parse(row.evidence_json)) };
  }

  async function readContext(threadId: string) {
    const { environmentId } = await worktreeForThread(threadId);
    if (readWorktreeState.get(environmentId)) return currentContext(threadId, !setupAutomation.isPlanner(threadId));
    const saved = taskFor(environmentId);
    return { status: "unassigned", environmentId, stage: null, stageUpdatedAt: null,
      ownerThreadId: null, taskRevision: saved.revision, task: saved.task,
      automaticSetup: null, blockedAttempt: null, activeStep: null, nextStep: null,
      setupComplete: false, completedStepIds: [], execution: null, requiredChecks: [],
      nextStage: null, paused: paused(environmentId), workspaceDigest: null,
      instruction: "No Worktree Stage is assigned. This read did not create a card or start a worker. For a new task, submit treelanes_deliver once to register this thread as orchestrator and wait in Design. Complete Design or wait for the user to start automation. For research or an explicit workflow opt-out, continue the requested work directly without board setup. Never submit completion evidence for an unassigned stage." };
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
    return { ...await modelPreferences(), environmentId, stage: state.stage, stageUpdatedAt: state.updated_at,
      ownerThreadId: state.owner_thread_id ?? null, taskRevision: saved.revision, task: saved.task,
      automaticSetup: setupAutomation.latest(environmentId) ?? null,
      orchestratorThreadId: setupAutomation.orchestrator(environmentId),
      blockedAttempt: blockedAttempt(environmentId),
      activeStep, nextStep, setupComplete: Boolean(db.prepare("SELECT 1 FROM worktree_setup_outcomes WHERE environment_id = ? AND task_revision = ?").get(environmentId, saved.revision)), completedStepIds: saved.task?.setup?.steps.slice(0, Math.max(0, saved.task.setup.steps.findIndex(step => step.id === state.active_step_id))).map(step => step.id) ?? [],
      execution: executionRow?.execution_json ? JSON.parse(executionRow.execution_json) : null,
      requiredChecks: state.stage === "design" ? saved.task?.stageChecks?.design ?? [] : [...new Set([...requiredStageChecks(state.stage, saved.task), ...(activeStep?.checks ?? [])])],
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
    if (current.task?.deliveryTarget === "pr" && task.deliveryTarget && task.deliveryTarget !== "pr") throw new Error("Keep PR Watch as the delivery target. Pause the task if its authority changed.");
    task.deliveryTarget ??= current.task?.deliveryTarget;
    requirePrWatch(task);
    normalizeLegacyDeliveryStages(task);
    const state = readWorktreeState.get(context.environmentId) as WorktreeStateRow;
    const launch = readStageThreadLaunch.get(context.environmentId, state.stage, state.updated_at) as StageThreadLaunchRow | undefined;
    const prepared = db.prepare("SELECT execution_json FROM worktree_stage_thread_launches WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
      .get(context.environmentId, state.stage, state.updated_at) as { execution_json: string | null } | undefined;
    task.setup = preserveCompletedSteps(current.task?.setup, task.setup, state.active_step_id);
    if (task.setup) validateKindSteps(task, task.setup);
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
    if (context.stage === "design" && setupAutomation.enabled(context.environmentId)) {
      if (context.ownerThreadId !== threadId) throw new Error("Only the Design owner can start automation at the user's request.");
      if (blockedAttempt(context.environmentId) || (await bb.sdk.threads.interactions.list({ threadId })).length) throw new Error("Resolve the recorded Design blocker or pending question before starting automation.");
      await moveWorktree(context.environmentId, "tdd", "User initiated automation", "cli");
      return { status: "planning", threadId: setupAutomation.orchestrator(context.environmentId) };
    }
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

  const automaticDeliverySchema = z.object({ stage: z.enum(["design", "tdd", "quality", "simplify", "pr"]).default("design"),
    task: taskContextSchema.omit({ setup: true, deliveryStages: true }), }).strict();
  async function deliverAutomatically(threadId: string, input: z.infer<typeof automaticDeliverySchema>) {
    const worktree = await worktreeForThread(threadId);
    if (setupAutomation.enabled(worktree.environmentId)) {
      input.task.deliveryTarget ??= setupAutomation.requestedTarget(worktree.environmentId);
      return setupAutomation.enqueue(worktree.environmentId, threadId, taskContextSchema.parse(input.task));
    }
    if (setupAutomation.isPlanner(threadId)) throw new Error("A setup worker cannot submit a new delivery request.");
    input.task.deliveryTarget ??= "pr";
    if (blockedAttempt(worktree.environmentId)) throw new Error("This task has recorded blocked checks. Resolve them before starting a new delivery.");
    const config = await settings.get();
    const assigned = readWorktreeState.get(worktree.environmentId) as WorktreeStateRow | undefined;
    const initialStage = config.startInDesign && (!assigned || assigned.stage === "design") ? "design" : input.stage;
    const moved = await moveThreadWorktree(threadId, initialStage, "Automatic delivery requested", "agent");
    if (moved.blockedReason) throw new Error(moved.blockedReason);
    await saveTaskContext(threadId, input.task);
    const job = setupAutomation.enqueue(worktree.environmentId, threadId, taskContextSchema.parse(input.task));
    await setupAutomation.tick(worktree.environmentId);
    return { queued: true, requestId: job.id, instruction: initialStage === "design" ? "This thread is the task orchestrator. Stay in Design and use /grilling. Automation starts after a checked design completion or an explicit user move to TDD." : "Read fresh context and follow the setup assignment in this thread. The board dispatches children after the plan is saved." };
  }
  const reopenRequestSchema = z.object({ taskRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000) }).strict();
  async function reopenTask(threadId: string, input: z.infer<typeof reopenRequestSchema>) {
    const context = await currentContext(threadId, false);
    const env = context.environmentId;
    const coordinatorId = setupAutomation.orchestrator(env);
    if (!coordinatorId || (threadId !== coordinatorId && threadId !== context.ownerThreadId)) {
      throw new Error("Only the saved orchestrator or current stage owner can reopen this task.");
    }
    if (context.stage !== "pr" || !context.activeStep || context.setupComplete || context.paused || setupAutomation.pending(env)) {
      throw new Error("Reopen requires an unpaused automatic task in PR Watch with no pending setup.");
    }
    if (context.taskRevision !== input.taskRevision) throw new Error("The task revision changed. Read fresh context before reopening.");
    const coordinator = await bb.sdk.threads.get({ threadId: coordinatorId });
    if (!coordinator || coordinator.archivedAt || coordinator.deletedAt || coordinator.environmentId !== env) {
      throw new Error("The saved orchestrator is unavailable. Restore it before reopening.");
    }
    const assertCurrent = () => {
      const state = readWorktreeState.get(env) as WorktreeStateRow;
      if (disposed || state.updated_at !== context.stageUpdatedAt || state.owner_thread_id !== context.ownerThreadId ||
          taskFor(env).revision !== input.taskRevision || paused(env) || setupAutomation.pending(env) || stageThreadStarts.has(`${env}:pr`)) {
        throw new Error("The task, owner, pause, or launch changed. Read fresh context before reopening.");
      }
      const launch = readStageThreadLaunch.get(env, "pr", state.updated_at) as StageThreadLaunchRow | undefined;
      if (launch?.status === "starting") throw new Error("A stage worker is starting. Wait before reopening.");
    };
    assertCurrent();
    for (const thread of (await listThreads(coordinator.projectId)).filter(t => t.environmentId === env)) {
      if ((thread.id !== threadId && hasLiveWork(thread)) || thread.hasPendingInteraction ||
          (await bb.sdk.threads.interactions.list({ threadId: thread.id })).length ||
          (await bb.sdk.threads.queuedMessages.list({ threadId: thread.id })).length) {
        throw new Error("A thread has live work or pending input. Resolve it before reopening.");
      }
    }
    assertCurrent();
    const task = taskContextSchema.parse({ ...context.task, setup: undefined, deliveryStages: undefined });
    const revision = context.taskRevision + 1;
    const version = Math.max(Date.now(), context.stageUpdatedAt + 1);
    const job = db.transaction(() => {
      db.prepare("UPDATE worktree_task_contexts SET revision = ?, context_json = ? WHERE environment_id = ?").run(revision, JSON.stringify(task), env);
      db.prepare("INSERT INTO worktree_task_versions VALUES (?, ?, ?, ?)").run(env, revision, JSON.stringify(task), version);
      db.prepare("UPDATE worktree_stage_thread_launches SET status = 'paused', last_error = 'Task reopened in Design' WHERE environment_id = ? AND stage = 'pr' AND stage_updated_at = ?")
        .run(env, context.stageUpdatedAt);
      db.prepare("UPDATE worktree_cards SET stage = 'design', updated_at = ?, active_step_id = NULL, owner_thread_id = ?, note = ? WHERE environment_id = ?")
        .run(version, coordinatorId, input.reason, env);
      addWorktreeHistory.run(env, "design", `Reopened: ${input.reason}`, "agent", version);
      return setupAutomation.reopen(env, input.reason);
    })();
    bb.realtime.publish("board-changed", { environmentId: env, stage: "design" });
    return { stage: "design", taskRevision: revision, ownerThreadId: coordinatorId, requestId: job.id,
      instruction: "The saved orchestrator must update the authorized task in Design. Prior receipts remain history. Complete Design or use explicit user Start before planning fresh checks." };
  }

  const recoveryRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000),
    nextAction: z.string().trim().min(1).max(1000).optional(), }).strict();
  async function requestPlanRecovery(threadId: string, reason: string, nextAction?: string) {
    const context = await currentContext(threadId, false);
    if (context.ownerThreadId !== threadId || context.paused) throw new Error("Only the unpaused current worker can request plan recovery.");
    if (context.setupComplete) throw new Error("The saved setup already completed.");
    const interactions = await bb.sdk.threads.interactions.list({ threadId });
    if (interactions.length) throw new Error("Resolve pending input before requesting plan recovery.");
    const state = readWorktreeState.get(context.environmentId) as WorktreeStateRow;
    if (state.owner_thread_id !== threadId || state.updated_at !== context.stageUpdatedAt ||
        taskFor(context.environmentId).revision !== context.taskRevision || paused(context.environmentId)) {
      throw new Error("The task, owner, or pause changed while requesting recovery. Read fresh context.");
    }
    const blocker = blockedAttempt(context.environmentId);
    if (blocker) {
      if (!blocker.evidence.decisionsResolved) throw new Error("Resolve the recorded human decision before recovery.");
      if (!nextAction) throw new Error("Recorded checks are blocked. Supply nextAction with a concrete in-scope change before recovery. Unchanged base or external failures do not justify another TDD worker.");
    }
    const job = setupAutomation.recover(context.environmentId, nextAction ? `Next action: ${nextAction}\nFailure: ${reason}` : reason);
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
    return { ...await modelPreferences(), providers: providers.map(provider => ({ id: provider.id, name: provider.displayName, available: provider.available })),
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
    const checks = new Map(evidence.checks.map(check => [check.name, check]));
    if (checks.size !== evidence.checks.length) throw new Error("Check names must be unique.");
    if (evidence.checks.some(check => !check.evidence.trim())) throw new Error("Each check needs evidence or a reason.");
    const prDelivery = context.task?.deliveryTarget === "pr" || context.task?.setup?.steps.at(-1)?.stage === "pr";
    const nonTaskFailure = (check: typeof evidence.checks[number]) =>
      prDelivery && evidence.stage !== "design" && Boolean(check.nonTaskFailure) && check.status !== "passed";
    const missingChecks = context.requiredChecks.filter(name => {
      const check = checks.get(name);
      return !check || (check.status !== "passed" && !nonTaskFailure(check));
    });
    const problem = !evidence.decisionsResolved ? "Resolve the required decisions before completion."
      : evidence.openFindings.length ? `Resolve the required findings before completion: ${evidence.openFindings.join("; ")}`
      : missingChecks.length ? `Required check has not passed: ${missingChecks.join("; ")}`
      : evidence.checks.some(check => !["passed", "skipped"].includes(check.status) && !nonTaskFailure(check)) ||
        (evidence.stage !== "design" && !evidence.checks.some(check => check.status === "passed"))
        ? "Implementation needs passing check evidence. Optional skipped checks need a reason." : null;
    // Re-read after the host snapshot before saving either success or a blocker.
    const state = readWorktreeState.get(context.environmentId) as WorktreeStateRow;
    if (state.updated_at !== context.stageUpdatedAt || state.owner_thread_id !== threadId ||
        taskFor(context.environmentId).revision !== context.taskRevision) throw new Error("The task changed while recording completion.");
    if (evidence.nextAction && !problem) {
      throw new Error("Passing evidence does not need nextAction. Remove the repair action before completing the stage.");
    }
    const repairRequested = Boolean(evidence.nextAction && ["tdd", "quality", "simplify"].includes(evidence.stage) && evidence.decisionsResolved);
    if (problem) {
      db.transaction(() => {
        db.prepare(`INSERT INTO worktree_blocked_attempts VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(environment_id) DO UPDATE SET stage_updated_at = excluded.stage_updated_at,
          task_revision = excluded.task_revision, thread_id = excluded.thread_id,
          evidence_json = excluded.evidence_json, reason = excluded.reason, recorded_at = excluded.recorded_at`)
          .run(context.environmentId, context.stageUpdatedAt, context.taskRevision, threadId, JSON.stringify(evidence), problem.slice(0, 4096), Date.now());
        db.prepare("DELETE FROM worktree_stage_results WHERE environment_id = ? AND stage_updated_at = ?")
          .run(context.environmentId, context.stageUpdatedAt);
        if (repairRequested) tddRepair.record(context.environmentId, threadId, evidence);
      })();
      bb.realtime.publish("board-changed", { environmentId: context.environmentId, stage: context.stage });
      if (repairRequested) return { recorded: false, action: "repair", stage: context.stage,
        repairStatus: tddRepair.read(context.environmentId, evidence)!.status,
        instruction: "Failure evidence saved. Continue the concrete repair in this thread. A pending repair continues once after a normal yield. An already sent, cancelled, or uncertain repair is not sent again. Keep the failure evidence; submit fresh passing checks before any completion marker." };
      throw new Error(`${problem.slice(0, 4096)} Blocker saved. Do not repeat unchanged checks or emit a completion marker. ${["tdd", "quality", "simplify"].includes(context.stage) && evidence.decisionsResolved
        ? "Diagnose and fix this in the same thread. If you yield with a concrete in-scope repair left, resubmit the failed evidence with nextAction to continue that repair automatically. External dependencies with no local repair remain visible."
        : "Resolve it in scope, or stop with the evidence. Recovery requires a concrete nextAction."}`);
    }
    db.transaction(() => {
      db.prepare("DELETE FROM worktree_blocked_attempts WHERE environment_id = ?").run(context.environmentId);
      db.prepare(`INSERT INTO worktree_stage_results (environment_id, stage_updated_at, thread_id, task_revision, evidence_json, step_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(environment_id, stage_updated_at) DO UPDATE SET thread_id = excluded.thread_id,
        task_revision = excluded.task_revision, evidence_json = excluded.evidence_json`)
        .run(context.environmentId, context.stageUpdatedAt, threadId, context.taskRevision, JSON.stringify(evidence), context.activeStep?.id ?? null);
      db.prepare("UPDATE worktree_stage_thread_launches SET last_error = NULL WHERE environment_id = ? AND stage = ? AND stage_updated_at = ?")
        .run(context.environmentId, context.stage, context.stageUpdatedAt);
    })();
    bb.realtime.publish("board-changed", { environmentId: context.environmentId, stage: context.stage });
    return { recorded: true, stage: context.stage, stageUpdatedAt: context.stageUpdatedAt,
      ...(evidence.checks.some(nonTaskFailure) ? { validationLimits: evidence.checks.filter(nonTaskFailure), instruction: "Stage recorded with non-task failures. Preserve failed statuses through Quality, Simplify and PR Watch. PR Watch owns getting required checks green; do not report ready to merge before then." } : {}) };
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
      if (!state || state.owner_thread_id !== threadId || blockedAttempt(environmentId)) return;
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
      if (blockedAttempt(environmentId) || paused(environmentId)) return;
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
  async function reconcileWorktrees(options: { force?: boolean; projectId?: string | null; environmentId?: string } = {}) {
    if (disposed) return;
    if (recovery) {
      await recovery;
      if (options.force) return reconcileWorktrees(options);
      return;
    }
    recovery = (async () => {
      if (options.environmentId) await setupAutomation.tick(options.environmentId, options.force);
      else await setupAutomation.tickAll(options.force);
      const board = await getBoard(options.projectId ?? null);
      const config = await settings.get();
      for (const card of board.cards) {
        if (disposed) break;
        if (options.environmentId && card.environmentId !== options.environmentId) continue;
        if (paused(card.environmentId)) continue;
        try {
          const state = readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined;
          if (!state || state.updated_at !== card.stageUpdatedAt) continue;
          if (setupAutomation.pending(card.environmentId) && state.stage !== "design") continue;
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
          const blocker = blockedAttempt(card.environmentId);
          if (blocker) {
            if (config.autoAdvanceImplementation && ["tdd", "quality", "simplify"].includes(state.stage) && blocker.evidence.nextAction && blocker.evidence.decisionsResolved) {
              await tddRepair.continueRepair(card.environmentId, blocker.evidence, () => {
                const current = blockedAttempt(card.environmentId);
                return !paused(card.environmentId) && !setupAutomation.pending(card.environmentId) &&
                  current?.recordedAt === blocker.recordedAt && JSON.stringify(current.evidence) === JSON.stringify(blocker.evidence) &&
                  (readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined)?.owner_thread_id === state.owner_thread_id;
              });
            }
            const saved = taskFor(card.environmentId);
            const orchestratorId = setupAutomation.orchestrator(card.environmentId);
            if (config.autoAdvanceImplementation && orchestratorId && state.owner_thread_id && blocker.evidence.decisionsResolved && !blocker.evidence.nextAction &&
                (saved.task?.deliveryTarget === "pr" || saved.task?.setup?.steps.at(-1)?.stage === "pr")) {
              await stageContinuation.help(orchestratorId, state.owner_thread_id, card.environmentId,
                `${card.environmentId}:${state.updated_at}:${saved.revision}`, blocker.reason, () => {
                  const latest = blockedAttempt(card.environmentId);
                  return !paused(card.environmentId) && !setupAutomation.pending(card.environmentId) && latest?.recordedAt === blocker.recordedAt &&
                    (readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined)?.owner_thread_id === state.owner_thread_id;
                });
            }
            continue;
          }
          if (state.stage === "pr") {
            const pr = await bb.sdk.environments.pullRequest({ environmentId: card.environmentId });
            if (pr.outcome === "available" && pr.pullRequest.state === "merged") {
              await moveWorktree(card.environmentId, "done", "Pull request merge verified.", "automation");
              continue;
            }
            if (pr.outcome === "unavailable" || (pr.outcome === "available" && pr.pullRequest.state === "closed")) continue;
          }
          if (state.owner_thread_id && !["design", "review", "done", "tickets"].includes(state.stage)) {
            const owner = await bb.sdk.threads.get({ threadId: state.owner_thread_id });
            if (owner?.status === "error") {
              if (!options.force && (state.stage === "pr" ? config.simplifyToPrMode !== "auto" : !config.autoAdvanceImplementation)) continue;
              const revision = taskFor(card.environmentId).revision;
              await threadRetry.retry(owner.id, card.environmentId, `stage:${card.environmentId}:${state.updated_at}:${revision}`, () => {
                const current = readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined;
                return current?.updated_at === state.updated_at && current.owner_thread_id === owner.id &&
                  taskFor(card.environmentId).revision === revision && !paused(card.environmentId) &&
                  !blockedAttempt(card.environmentId) && !setupAutomation.pending(card.environmentId);
              }, options.force);
              continue;
            }
          }
          if (state.owner_thread_id) await advanceCompleted(card.environmentId, state.owner_thread_id);
          const current = readWorktreeState.get(card.environmentId) as WorktreeStateRow;
          if (current.updated_at !== state.updated_at) continue;
          const saved = taskFor(card.environmentId);
          if (config.autoAdvanceImplementation && state.owner_thread_id && ["tdd", "quality", "simplify"].includes(state.stage) &&
              (saved.task?.deliveryTarget === "pr" || saved.task?.setup?.steps.at(-1)?.stage === "pr") &&
              !readResult.get(card.environmentId, state.updated_at)) {
            await stageContinuation.resume(state.owner_thread_id, card.environmentId, state.stage,
              `${card.environmentId}:${state.updated_at}:${saved.revision}`, () => {
                const latest = readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined;
                return latest?.updated_at === state.updated_at && latest.owner_thread_id === state.owner_thread_id &&
                  taskFor(card.environmentId).revision === saved.revision && !paused(card.environmentId) &&
                  !blockedAttempt(card.environmentId) && !readResult.get(card.environmentId, state.updated_at) && !setupAutomation.pending(card.environmentId);
              });
          }
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
      const blocker = blockedAttempt(card.environmentId);
      const repair = blocker ? tddRepair.describe(card.environmentId, blocker.evidence, card.status === "active", paused(card.environmentId), card.hasPendingInteraction) : null;
      if (blocker) return [{ environmentId: card.environmentId, projectId: card.projectId, stage: card.stage,
        stageUpdatedAt: card.stageUpdatedAt, status: repair?.status ?? "checks-blocked", attempts: launch?.attempt_count ?? 0,
        error: repair?.message ?? blocker.reason, waitingForInput: !blocker.evidence.decisionsResolved || card.hasPendingInteraction,
        hasLiveWork: card.status === "active", paused: paused(card.environmentId) }];
      const state = readWorktreeState.get(card.environmentId) as WorktreeStateRow | undefined;
      const job = setupAutomation.latest(card.environmentId);
      const retryThreadId = job && ["pending", "starting", "started", "blocked"].includes(job.status) ? job.thread_id : state?.owner_thread_id;
      const retryAssignment = job && ["pending", "starting", "started", "blocked"].includes(job.status)
        ? `setup:${job.id}` : `stage:${card.environmentId}:${card.stageUpdatedAt}:${taskFor(card.environmentId).revision}`;
      const retry = retryThreadId ? threadRetry.read(retryThreadId, retryAssignment) : undefined;
      if (retry && ["blocked", "uncertain", "claimed"].includes(retry.status) && retryThreadId &&
          (await bb.sdk.threads.get({ threadId: retryThreadId }).catch(() => null))?.status === "error") {
        return [{ environmentId: card.environmentId, projectId: card.projectId, stage: card.stage, stageUpdatedAt: card.stageUpdatedAt,
          status: `retry-${retry.status}`, error: retry.error ?? "Retry dispatch has an uncertain result. Keep the assigned thread.",
          threadId: retryThreadId, paused: paused(card.environmentId), waitingForInput: card.hasPendingInteraction, hasLiveWork: false }];
      }
      const setupJob = setupAutomation.latest(card.environmentId);
      if (!paused(card.environmentId) && setupJob &&
          (["pending", "starting", "started", "blocked"].includes(setupJob.status) ||
           (setupJob.status === "stale" && setupJob.stage_updated_at === card.stageUpdatedAt))) {
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
        else if (owner.status === "error") { status = "worker-failed"; error ??= "The stage worker failed. The board retries the same thread within its saved retry limit."; }
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
      sidebarState.lifecycle(),
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
      lifecycle.flatMap((row) =>
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
        const blocker = blockedAttempt(environmentId);
        const savedTask = taskFor(environmentId);
        const completeLocally = !["pr", "done"].includes(stage) && savedTask.task?.setup?.steps.at(-1)?.stage !== "pr" &&
          !rows.some(thread => hasLiveWork(thread) || thread.hasPendingInteraction) &&
          Boolean(db.prepare("SELECT 1 FROM worktree_setup_outcomes WHERE environment_id = ? AND task_revision = ?")
            .get(environmentId, savedTask.revision));
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
          note: blocker ? tddRepair.describe(environmentId, blocker.evidence, rows.some(hasLiveWork), paused(environmentId), rows.some(thread => thread.hasPendingInteraction))?.message ?? `Blocked: ${blocker.reason}`
            : completeLocally ? "Complete locally. No PR step is planned." : saved?.note ?? null,
          status: worktreeStatus(rows),
          hasPendingInteraction: rows.some(
            (thread) => thread.hasPendingInteraction === true,
          ),
          updatedAt: Math.max(...rows.map((thread) => thread.updatedAt)),
          stageUpdatedAt: saved?.updated_at ?? Math.min(...rows.map((thread) => thread.createdAt)),
          pendingThreadStart:
            launch?.status === "pending" && !blocker
              ? { stage, label: stage === "pr" ? "Start PR thread" : `Start ${stageLabel(stage)} thread` }
              : null,
          threads: rows.map((thread) => ({
            id: thread.id,
            title: displayTitle(thread),
            status: thread.status,
            updatedAt: thread.updatedAt,
            parentThreadId: thread.parentThreadId,
            hasPendingInteraction: thread.hasPendingInteraction === true,
            canSettle: !thread.hasPendingInteraction && !hasLiveWork(thread),
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
    settleThread: async ({ threadId }) => {
      const target = await bb.sdk.threads.get({ threadId });
      const thread = (await listThreads(target.projectId)).find((row) => row.id === threadId);
      if (!thread || !isWorktreeThread(thread)) {
        throw new Error("This thread is not on the board.");
      }
      if (thread.hasPendingInteraction || hasLiveWork(thread)) {
        throw new Error("This thread has live work or a pending question. Wait before settling it.");
      }
      await sidebarState.settle({ threadId });
      bb.realtime.publish("board-changed", { environmentId: thread.environmentId });
      return { ok: true as const };
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
    name: "treelanes_move_card",
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
    name: "treelanes_get_context",
    description: "Read the saved task, owner, revisions and current file digest. A worktree without an assigned stage returns status unassigned without creating a card or starting work.",
    parameters: z.object({}),
    async execute(_input, context) { return JSON.stringify(await readContext(context.threadId)); },
  });
  bb.agents.registerTool({
    name: "treelanes_set_task",
    description: "Save the existing authorized outcome, scope, accepted decisions, required checks, and allowed actions for this worktree. Reuse decisions while their scope still applies.",
    parameters: taskContextSchema,
    async execute(input, context) { return JSON.stringify(await saveTaskContext(context.threadId, input)); },
  });
  bb.agents.registerTool({
    name: "treelanes_complete_stage",
    description: "Record actual check evidence from fresh context. Only recorded:true permits a completion marker and later dispatch. For an incomplete TDD, Quality or Simplify step, include nextAction for a concrete repair in this thread. See /delivery for receipt and recovery rules.",
    parameters: completionEvidenceSchema,
    async execute(input, context) { return JSON.stringify(await submitCompletion(context.threadId, input)); },
  });

  bb.agents.registerTool({
    name: "treelanes_start",
    description: "Only when the user explicitly asks to start: open a saved automatic task from Design and continue planning in its original thread. Never use this to infer Design approval. For manual setups, start the saved current step once. Pauses and pending questions block dispatch.",
    parameters: z.object({}),
    async execute(_input, context) { return JSON.stringify(await startSavedSetup(context.threadId)); },
  });
  bb.agents.registerTool({
    name: "treelanes_catalog",
    description: "Inspect installed harnesses, exact available models and effort levels, and relevant skills before choosing a task setup. Give providerId to read models and skillQuery to narrow skills.",
    parameters: z.object({ providerId: z.string().max(128).optional(), skillQuery: z.string().max(160).optional() }),
    async execute(input, context) { return JSON.stringify(await setupCatalog(context.threadId, input.providerId, input.skillQuery)); },
  });
  bb.agents.registerTool({
    name: "treelanes_playbooks",
    description: "Read recent checked setups in this project as starting points for a new task. Prior results never grant authority or validate new work.",
    parameters: z.object({}),
    async execute(_input, context) { return JSON.stringify(setupPlaybooks(context.projectId)); },
  });

  bb.agents.registerTool({ name: "treelanes_deliver", description: "Register the task once. New tasks wait in Design by default. This thread remains the orchestrator; after checked Design completion or explicit user Start it plans from live catalogs, then the board dispatches children. Do not start TDD from an unconfirmed design.",
    parameters: automaticDeliverySchema,
    async execute(input, context) { return JSON.stringify(await deliverAutomatically(context.threadId, input)); },
  });
  bb.agents.registerTool({ name: "treelanes_apply_setup", description: "Assigned setup worker only: validate and save the setup proposal. The board retains the authorized task and dispatches after this worker is idle.",
    parameters: setupProposalSchema,
    async execute(input, context) { return JSON.stringify(await setupAutomation.apply(context.threadId, input.setup)); },
  });
  bb.agents.registerTool({ name: "treelanes_reopen", description: "Only at the user's request: reopen an idle PR Watch task in Design for changed work. Keep its history and original orchestrator; fresh checks are required. Read context and pass its taskRevision.",
    parameters: reopenRequestSchema,
    async execute(input, context) { return JSON.stringify(await reopenTask(context.threadId, input)); },
  });
  bb.agents.registerTool({ name: "treelanes_recover", description: "Current worker only: request a bounded plan change after a technical failure. A recorded blocker requires nextAction with a concrete in-scope change. Do not retry unchanged base or external failures. Preserve scope and checks. End the turn; the setup worker replans after you are idle. Never use for pending human decisions.",
    parameters: recoveryRequestSchema,
    async execute(input, context) { return JSON.stringify(await requestPlanRecovery(context.threadId, input.reason, input.nextAction)); },
  });

  // The setup worker gets only the skills its instructions name; board threads get every skill in skills/.
  bb.agents.configure(context => setupAutomation.isPlanner(context.thread.id, context.thread.title) ? {
    tools: ["treelanes_reopen", "treelanes_apply_setup", "treelanes_catalog", "treelanes_get_context", "treelanes_playbooks"], skills: ["delivery", "ponytail"],
    instructions: "Use /delivery as the persistent task orchestrator. Follow the current assignment: submit setup or guide the existing child. The board owns dispatch and card moves; do not edit product code.",
  } : ({
    tools: ["treelanes_reopen", "treelanes_move_card", "treelanes_get_context", "treelanes_set_task", "treelanes_complete_stage", "treelanes_start", "treelanes_catalog", "treelanes_playbooks", "treelanes_deliver", "treelanes_recover"],
    skills: [...PLUGIN_SKILLS],
    instructions:
      "For Git Worktree delivery, use /delivery. Honor explicit workflow opt-outs. New tasks use treelanes_deliver once; existing workers follow fresh board context. The board owns dispatch and card moves after checked receipts. Keep the Design Gate, saved authority and user stops. Use review for external /code-review and done only after a verified PR merge.",
  }));

  const cliCommands = [
      { name: "deliver", summary: "Plan and run an authorized task", usage: "bb treelanes deliver '<json>'" },
      { name: "apply-setup", summary: "Submit the assigned setup proposal", usage: "bb treelanes apply-setup '<json>'" },
      { name: "reopen", summary: "Reopen PR Watch in Design at the user's request", usage: `bb treelanes reopen '{"taskRevision":2,"reason":"User requested changed work"}'` },
      { name: "recover", summary: "Request bounded plan recovery", usage: `bb treelanes recover '{"reason":"...","nextAction":"..."}'` },
      { name: "start", summary: "Start the saved setup step once", usage: "bb treelanes start" },
      { name: "catalog", summary: "Read live setup choices", usage: "bb treelanes catalog [provider-id] [skill-query]" },
      { name: "playbooks", summary: "Read recent checked setups", usage: "bb treelanes playbooks [project-id]" },
      { name: "history", summary: "Read saved task revisions", usage: "bb treelanes history" },
      { name: "show", summary: "Show worktree stages", usage: "bb treelanes show [project-id]" },
      { name: "move", summary: "Move the worktree for a thread", usage: "bb treelanes move <stage> [thread-id] [note]" },
      { name: "snapshot", summary: "Read the current worktree file digest", usage: "bb treelanes snapshot <environment-id>" },
      { name: "context", summary: "Read saved task and current file revision", usage: "bb treelanes context" },
      { name: "task", summary: "Save the authorized work request", usage: "bb treelanes task '<json>'" },
      { name: "complete", summary: "Record checked stage completion", usage: "bb treelanes complete '<json>'" },
      { name: "health", summary: "Read pending and failed launches as JSON", usage: "bb treelanes health [project-id]" },
      { name: "reconcile", summary: "Recover eligible stage launches and check merged PRs", usage: "bb treelanes reconcile [project-id]" },
      { name: "pause", summary: "Pause automatic work for a worktree", usage: "bb treelanes pause [environment-id]" },
      { name: "resume", summary: "Resume automatic work for a worktree", usage: "bb treelanes resume [environment-id]" },
      { name: "stages", summary: "List valid stages", usage: "bb treelanes stages" },
      { name: "import", summary: "Copy old workflow-board and worktree-sidebar data once into a new install", usage: "bb treelanes import" },
      { name: "list-main", summary: "Show saved and preferred sidebar main threads and group order", usage: "bb treelanes list-main" },
      { name: "main", summary: "Choose a sidebar main thread", usage: "bb treelanes main <project> <environment> <thread>" },
      { name: "titles", summary: "Show automatic title choice, stored names and errors", usage: "bb treelanes titles" },
      { name: "generate-titles", summary: "Process one pending title batch", usage: "bb treelanes generate-titles" },
    ];
  const cliHelp = `Treelanes commands:\n${cliCommands.map(command => `${command.usage}\n  ${command.summary}`).join("\n")}\n`;
  bb.cli.register({
    name: "treelanes",
    summary: "Read and move worktree cards",
    commands: cliCommands,
    async run(argv, context) {
      const [command, ...args] = argv;
      if (!command || ["--help", "-h", "help"].includes(command)) return { exitCode: 0, stdout: cliHelp };
      if (["deliver", "apply-setup", "recover", "reopen"].includes(command ?? "")) {
        if (!context.threadId) return { exitCode: 2, stderr: "Run this command in its task thread.\n" };
        const threadId = context.threadId;
        const result = command === "deliver" ? await deliverAutomatically(context.threadId, automaticDeliverySchema.parse(JSON.parse(args.join(" "))))
          : command === "reopen" ? await reopenTask(threadId, reopenRequestSchema.parse(JSON.parse(args.join(" "))))
          : command === "apply-setup" ? await setupAutomation.apply(context.threadId, setupProposalSchema.parse(JSON.parse(args.join(" "))).setup)
          : await (async () => {
            const text = args.join(" ");
            const input = recoveryRequestSchema.parse(text.trimStart().startsWith("{") ? JSON.parse(text) : { reason: text });
            return requestPlanRecovery(threadId, input.reason, input.nextAction);
          })();
        return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
      }
      if (command === "import") {
        const result = importOldData(db, bb.server.experimental_dataDir);
        for (const channel of ["board-changed", "lifecycle", "order", "groups", "titles"]) bb.realtime.publish(channel, {});
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
        const result = command === "context" ? await readContext(context.threadId)
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
        if (command === "resume") await reconcileWorktrees({ force: true, environmentId });
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
      const sidebarResult = await sidebarState.cli(argv);
      if (sidebarResult) return sidebarResult;
      return { exitCode: 2, stderr: `Unknown treelanes command: ${command}\n${cliHelp}` };
    },
  });

  const publishThreadChange = ({ thread }: { thread: { id: string } }) => {
    bb.realtime.publish("board-changed", { threadId: thread.id });
  };
  bb.events.on("thread.created", publishThreadChange);
  bb.events.on("thread.active", publishThreadChange);
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    publishThreadChange({ thread });
    if (thread.environmentId && (setupAutomation.enabled(thread.environmentId) || blockedAttempt(thread.environmentId)?.evidence.nextAction)) await reconcileWorktrees({ environmentId: thread.environmentId });
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
  bb.log.info("Treelanes loaded");
}
