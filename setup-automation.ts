import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskContext } from "./stage-evidence";
import type { SetupPlan } from "./setup-plan";
import { buildSetupPrompt, validateSetupProposal } from "./setup-request";
import { resolveStepExecution } from "./step-execution";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
type Thread = { id: string; projectId: string; environmentId?: string | null; providerId: string;
  title?: string | null; status: "active" | "idle" | "error" | "pending" | "starting" | "stopping"; hasPendingInteraction?: boolean;
  activity?: { activeWorkflowCount: number; activeBackgroundAgentCount: number; activeBackgroundCommandCount: number; activePlanModeCount: number; activeGoalCount: number };
};
export type AutomationContext = {
  environmentId: string; stage: string; stageUpdatedAt: number; taskRevision: number;
  task: TaskContext | null; activeStepId: string | null; paused: boolean;
};
export type SetupRequest = {
  id: number; environment_id: string; kind: "initial" | "recovery"; task_revision: number;
  stage_updated_at: number; status: string; thread_id: string | null; attempts: number;
  prepared_json: string | null; reason: string | null; updated_at: number;
  next_attempt_at: number; last_error: string | null;
};

export const setupAutomationMigration = `CREATE TABLE worktree_delivery_runs (
  environment_id TEXT PRIMARY KEY, initiator_thread_id TEXT NOT NULL, request_json TEXT NOT NULL,
  recovery_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE worktree_setup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, environment_id TEXT NOT NULL, kind TEXT NOT NULL,
  task_revision INTEGER NOT NULL, stage_updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', thread_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  prepared_json TEXT, reason TEXT, updated_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE INDEX worktree_setup_requests_env ON worktree_setup_requests(environment_id, id DESC);`;

export function createSetupAutomation(bb: BbPluginApi, db: Db, hooks: {
  context(environmentId: string): AutomationContext;
  commit(request: SetupRequest, plan: SetupPlan): void;
  playbooks(projectId: string): unknown;
  listThreads(projectId: string): Promise<Thread[]>;
  hasLiveWork(thread: Thread): boolean;
  disposed(): boolean;
}) {
  const locks = new Map<string, Promise<void>>();
  const latest = (env: string) => db.prepare("SELECT * FROM worktree_setup_requests WHERE environment_id = ? ORDER BY id DESC LIMIT 1").get(env) as SetupRequest | undefined;
  const readRun = (env: string) => db.prepare("SELECT * FROM worktree_delivery_runs WHERE environment_id = ?").get(env) as { initiator_thread_id: string; request_json: string; recovery_count: number } | undefined;
  const title = (job: SetupRequest) => `Workflow setup [${job.environment_id}:${job.id}:${job.attempts}]`;
  const pending = (env: string) => { const job = latest(env); return Boolean(job && ["pending", "starting", "started", "blocked"].includes(job.status)); };
  const isPlanner = (id: string, threadTitle?: string | null) => Boolean(db.prepare("SELECT 1 FROM worktree_setup_requests WHERE thread_id = ?").get(id)) || Boolean(threadTitle?.startsWith("Workflow setup [") && db.prepare("SELECT * FROM worktree_setup_requests WHERE status = 'starting'").all().some(row => title(row as SetupRequest) === threadTitle));
  const fresh = (job: SetupRequest) => {
    const state = hooks.context(job.environment_id);
    if (state.taskRevision !== job.task_revision || state.stageUpdatedAt !== job.stage_updated_at) throw new Error("Setup request is stale. The task or stage changed.");
    if (!state.task || state.paused || ["design", "review", "done", "tickets"].includes(state.stage)) throw new Error("Setup requires an unpaused implementation or PR task beyond Design.");
    return state;
  };
  function insert(env: string, kind: SetupRequest["kind"], reason: string | null) {
    const state = hooks.context(env);
    db.prepare("INSERT INTO worktree_setup_requests(environment_id, kind, task_revision, stage_updated_at, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(env, kind, state.taskRevision, state.stageUpdatedAt, reason, Date.now());
    return latest(env)!;
  }
  function enqueue(env: string, initiatorThreadId: string, request: TaskContext) {
    const run = readRun(env);
    if (run) {
      if (run.request_json !== JSON.stringify(request)) throw new Error("This worktree already has an automatic delivery request.");
      return latest(env)!;
    }
    return db.transaction(() => {
      db.prepare("INSERT INTO worktree_delivery_runs(environment_id, initiator_thread_id, request_json, created_at) VALUES (?, ?, ?, ?)")
        .run(env, initiatorThreadId, JSON.stringify(request), Date.now());
      return insert(env, "initial", null);
    })();
  }
  function recover(env: string, reason: string) {
    const run = readRun(env);
    if (!run) throw new Error("This task did not enable automatic delivery.");
    const job = latest(env);
    if (job && ["pending", "starting", "started", "blocked"].includes(job.status)) return job;
    if (run.recovery_count >= 2) throw new Error("Automatic plan recovery reached its limit of two changes.");
    const state = hooks.context(env);
    if (!state.task?.setup || !state.activeStepId || state.paused) throw new Error("No active unpaused setup can recover.");
    return db.transaction(() => {
      db.prepare("UPDATE worktree_delivery_runs SET recovery_count = recovery_count + 1 WHERE environment_id = ?").run(env);
      return insert(env, "recovery", reason.slice(0, 2000));
    })();
  }
  async function catalog(environmentId: string, projectId: string) {
    const providers = (await bb.sdk.providers.list({ environmentId })).filter(provider => provider.available).slice(0, 12);
    const skills = await bb.sdk.skills.list({ environmentId, projectId });
    const models = await Promise.all(providers.map(async provider => {
      try {
        const values = await bb.sdk.providers.models({ environmentId, providerId: provider.id });
        return { providerId: provider.id, error: values.modelLoadError, models: values.models.slice(0, 40).map(model => ({
          id: model.id, model: model.model, description: model.description.slice(0, 500), supportedReasoningEfforts: model.supportedReasoningEfforts,
        })) };
      } catch { return { providerId: provider.id, error: "Catalog unavailable", models: [] }; }
    }));
    return { providers: models, skills: skills.skills.slice(0, 100).map(({ id, name, description, provider }) => ({ id, name, description: description?.slice(0, 300), provider })),
      note: "Catalog lists are bounded. Use workflow_board_catalog for another provider or relevant skills if needed." };
  }
  async function waiting(thread: Thread) {
    return thread.hasPendingInteraction || (await bb.sdk.threads.interactions.list({ threadId: thread.id })).length > 0 ||
      (await bb.sdk.threads.queuedMessages.list({ threadId: thread.id })).length > 0;
  }
  async function tickUnlocked(env: string) {
    let job = latest(env);
    if (!job || ["applied", "blocked", "stale"].includes(job.status) || hooks.disposed()) return;
    const state = hooks.context(env);
    if (state.paused) return;
    if (state.stageUpdatedAt !== job.stage_updated_at || state.taskRevision !== job.task_revision) {
      db.prepare("UPDATE worktree_setup_requests SET status = 'stale', last_error = 'Task or stage changed' WHERE id = ?").run(job.id); return;
    }
    const run = readRun(env)!;
    const source = await bb.sdk.threads.get({ threadId: run.initiator_thread_id });
    const threads = (await hooks.listThreads(source.projectId)).filter(thread => thread.environmentId === env);
    if (job.status === "starting") {
      const orphan = threads.find(thread => thread.title === title(job!));
      if (orphan) {
        db.prepare("UPDATE worktree_setup_requests SET status = 'started', thread_id = ?, last_error = NULL WHERE id = ?").run(orphan.id, job.id);
        job = latest(env)!;
      } else if (job.updated_at > Date.now() - 120_000) return;
      else {
        db.prepare("UPDATE worktree_setup_requests SET status = ?, last_error = 'Setup start lease expired' WHERE id = ?")
          .run(job.attempts >= 2 ? "blocked" : "pending", job.id);
        return;
      }
    }
    if (job.status === "started") {
      const worker = job.thread_id ? await bb.sdk.threads.get({ threadId: job.thread_id }) : null;
      if (worker && (hooks.hasLiveWork(worker) || await waiting(worker))) return;
      db.prepare("UPDATE worktree_setup_requests SET status = ?, next_attempt_at = ?, last_error = 'Setup worker ended without a validated plan' WHERE id = ?")
        .run(job.attempts >= 2 ? "blocked" : "pending", Date.now() + 30_000, job.id);
      return;
    }
    for (const thread of threads) {
      if (await waiting(thread)) return;
      if (thread.id !== run.initiator_thread_id && hooks.hasLiveWork(thread)) return;
    }
    if (job.next_attempt_at > Date.now() || job.attempts >= 2) return;
    const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: source.id });
    if (!execution?.model || !execution.reasoningLevel) throw new Error("The initiating thread must have explicit model and effort settings for setup planning.");
    const inheritedChoice = { providerId: source.providerId, model: execution.model, reasoningLevel: execution.reasoningLevel,
      permissionMode: execution.permissionMode ?? "auto", ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}) };
    const choice: typeof inheritedChoice = job.prepared_json ? JSON.parse(job.prepared_json) : inheritedChoice;
    const context = fresh(job);
    const prompt = buildSetupPrompt({ task: context.task!, stage: context.stage, activeStepId: context.activeStepId,
      recoveryReason: job.reason, catalog: await catalog(env, source.projectId), playbooks: hooks.playbooks(source.projectId) });
    fresh(job);
    if (hooks.disposed()) return;
    const claim = db.prepare("UPDATE worktree_setup_requests SET status = 'starting', attempts = attempts + 1, updated_at = ?, prepared_json = ? WHERE id = ? AND status = 'pending' AND attempts = ?")
      .run(Date.now(), JSON.stringify(choice), job.id, job.attempts);
    if (claim.changes !== 1) return;
    job = latest(env)!;
    try {
      const worker = await bb.sdk.threads.spawn({ ...choice, projectId: source.projectId, parentThreadId: source.id,
        environment: { type: "reuse", environmentId: env }, visibility: "hidden", title: title(job), prompt });
      // A fast worker can apply its plan before the spawn response arrives.
      db.prepare("UPDATE worktree_setup_requests SET thread_id = ?, status = CASE WHEN status = 'starting' THEN 'started' ELSE status END WHERE id = ?")
        .run(worker.id, job.id);
    } catch (error) {
      if (!hooks.disposed()) db.prepare("UPDATE worktree_setup_requests SET last_error = ? WHERE id = ?")
        .run(String(error).slice(0, 1000), job.id);
      // Leave the starting claim intact until orphan lookup settles the uncertain spawn.
    }
  }
  async function tick(env: string) {
    if (locks.has(env)) return locks.get(env);
    const promise = tickUnlocked(env); locks.set(env, promise);
    try { await promise; }
    catch (error) {
      if (!hooks.disposed()) {
        const job = latest(env);
        if (job?.status === "pending" && !hooks.context(env).paused) db.prepare("UPDATE worktree_setup_requests SET attempts = attempts + 1, status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
          .run(job.attempts >= 1 ? "blocked" : "pending", Date.now() + 30_000, String(error).slice(0, 1000), job.id);
      }
      throw error;
    } finally { locks.delete(env); }
  }
  async function apply(threadId: string, plan: SetupPlan) {
    const thread = await bb.sdk.threads.get({ threadId });
    const job = thread.environmentId ? latest(thread.environmentId) : undefined;
    if (!job || !["starting", "started"].includes(job.status) || (job.thread_id !== threadId && !(job.status === "starting" && thread.title === title(job)))) {
      throw new Error("Only the assigned setup worker can submit this plan.");
    }
    const context = fresh(job);
    if (await waiting(thread)) throw new Error("Resolve pending input before applying a setup.");
    const run = readRun(job.environment_id)!;
    for (const other of (await hooks.listThreads(thread.projectId)).filter(t => t.environmentId === job.environment_id && t.id !== threadId)) {
      if (await waiting(other) || (other.id !== run.initiator_thread_id && hooks.hasLiveWork(other))) throw new Error("Another thread has live work or pending input.");
    }
    validateSetupProposal(context.task!, plan, context.stage, context.activeStepId, job.kind === "recovery");
    await Promise.all(plan.steps.map(step => resolveStepExecution(bb.sdk, { environmentId: job.environment_id, projectId: thread.projectId }, step.execution)));
    fresh(job);
    if (hooks.disposed()) throw new Error("Plugin reloaded before setup submission.");
    return db.transaction(() => {
      if (latest(job.environment_id)?.status === "applied") throw new Error("This setup was already applied.");
      hooks.commit(job, plan);
      db.prepare("UPDATE worktree_setup_requests SET status = 'applied', thread_id = ?, last_error = NULL WHERE id = ?").run(threadId, job.id);
      return { saved: true, taskRevision: hooks.context(job.environment_id).taskRevision, dispatch: "after setup worker is idle" };
    })();
  }
  async function tickAll() {
    const rows = db.prepare("SELECT environment_id FROM worktree_delivery_runs").all() as { environment_id: string }[];
    await Promise.all(rows.map(async row => { try { await tick(row.environment_id); } catch (error) { if (!hooks.disposed()) bb.log.error(`Setup recovery for ${row.environment_id}: ${String(error)}`); } }));
  }
  return { enqueue, recover, apply, tick, tickAll, pending, isPlanner, latest, enabled: (env: string) => Boolean(readRun(env)),
    exhausted: (env: string) => (readRun(env)?.recovery_count ?? 0) >= 2 };
}
