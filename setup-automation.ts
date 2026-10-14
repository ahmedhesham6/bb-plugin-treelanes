import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskContext } from "./stage-evidence";
import type { SetupPlan } from "./setup-plan";
import { buildSetupPrompt, validateSetupProposal } from "./setup-request";
import { resolveStepExecution } from "./step-execution";
import { requireStepChoices, stepChoices, type Choices } from "./task-map";

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
  id: number; environment_id: string; kind: "initial" | "recovery" | "reopen"; task_revision: number;
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
  useInitiatingThread(): Promise<boolean>;
  choices(): Choices;
  commit(request: SetupRequest, plan: SetupPlan): void;
  listThreads(projectId: string): Promise<Thread[]>;
  hasLiveWork(thread: Thread): boolean;
  retryThread(threadId: string, environmentId: string, assignment: string, eligible: () => boolean, force?: boolean): Promise<void>;
  disposed(): boolean;
}) {
  const locks = new Map<string, Promise<void>>();
  const latest = (env: string) => db.prepare("SELECT * FROM worktree_setup_requests WHERE environment_id = ? ORDER BY id DESC LIMIT 1").get(env) as SetupRequest | undefined;
  const orchestrator = (env: string) => (db.prepare("SELECT thread_id FROM worktree_setup_requests WHERE environment_id = ? AND kind = 'initial' AND thread_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(env) as { thread_id: string } | undefined)?.thread_id ?? (db.prepare("SELECT initiator_thread_id FROM worktree_delivery_runs WHERE environment_id = ?").get(env) as { initiator_thread_id: string } | undefined)?.initiator_thread_id ?? null;
  const readRun = (env: string) => db.prepare("SELECT * FROM worktree_delivery_runs WHERE environment_id = ?").get(env) as { initiator_thread_id: string; request_json: string; recovery_count: number } | undefined;
  const title = (job: SetupRequest) => `Workflow orchestrator [${job.environment_id}:${job.id}:${job.attempts}]`;
  const pending = (env: string) => { const job = latest(env); return Boolean(job && ["pending", "starting", "started", "blocked"].includes(job.status)); };
  const isPlanner = (id: string, threadTitle?: string | null) => Boolean(db.prepare("SELECT 1 FROM worktree_setup_requests r JOIN worktree_cards c ON c.environment_id = r.environment_id WHERE r.thread_id = ? AND c.stage != 'design'").get(id)) || Boolean((threadTitle?.startsWith("Workflow setup [") || threadTitle?.startsWith("Workflow orchestrator [")) && db.prepare("SELECT * FROM worktree_setup_requests WHERE status = 'starting'").all().some(row => title(row as SetupRequest) === threadTitle));
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
  function openDesignGate(env: string) {
    const job = latest(env);
    const state = hooks.context(env);
    if (!job || job.kind === "recovery" || job.status !== "pending" || state.stage !== "tdd" || state.task?.setup) return;
    db.prepare("UPDATE worktree_setup_requests SET stage_updated_at = ?, task_revision = ? WHERE id = ?")
      .run(state.stageUpdatedAt, state.taskRevision, job.id);
  }
  function refreshInitial(env: string) {
    const job = latest(env);
    if (!job || job.kind === "recovery" || job.status === "applied") return job;
    const state = hooks.context(env);
    // A task edit keeps the delivery request, but its planner needs a new assignment.
    // Stage changes and completed setup planning do not grant a new initial start.
    if (state.taskRevision === job.task_revision || state.stageUpdatedAt !== job.stage_updated_at ||
        !state.task || state.task.setup || state.activeStepId || state.paused ||
        ["design", "review", "done", "tickets"].includes(state.stage)) return job;
    return db.transaction(() => {
      db.prepare("UPDATE worktree_setup_requests SET status = 'stale', last_error = 'Task changed before setup was applied' WHERE id = ?").run(job.id);
      return insert(env, job.kind, job.reason);
    })();
  }
  function recover(env: string, reason: string) {
    if (hooks.context(env).stage === "design") throw new Error("Keep pending design decisions in Design; recovery cannot start implementation.");
    const run = readRun(env);
    if (!run) throw new Error("This task did not enable automatic delivery.");
    const job = refreshInitial(env);
    if (job && ["pending", "starting", "started", "blocked"].includes(job.status)) return job;
    if (run.recovery_count >= 2) throw new Error("Automatic plan recovery reached its limit of two changes.");
    const state = hooks.context(env);
    if (!state.task?.setup || !state.activeStepId || state.paused) throw new Error("No active unpaused setup can recover.");
    return db.transaction(() => {
      db.prepare("UPDATE worktree_delivery_runs SET recovery_count = recovery_count + 1 WHERE environment_id = ?").run(env);
      return insert(env, "recovery", reason.slice(0, 2000));
    })();
  }
  async function waiting(thread: Thread) {
    return thread.hasPendingInteraction || (await bb.sdk.threads.interactions.list({ threadId: thread.id })).length > 0 ||
      (await bb.sdk.threads.queuedMessages.list({ threadId: thread.id })).length > 0;
  }
  async function tickUnlocked(env: string, force = false) {
    if (hooks.disposed()) return;
    let job = refreshInitial(env);
    if (!job || ["applied", "stale"].includes(job.status) || (job.status === "blocked" && !job.thread_id)) return;
    const state = hooks.context(env);
    if (state.paused) return;
    if (state.stage === "design") {
      if (state.stageUpdatedAt !== job.stage_updated_at) db.prepare("UPDATE worktree_setup_requests SET status = 'stale', last_error = 'Task returned to Design' WHERE id = ?").run(job.id);
      return;
    }
    if (state.stageUpdatedAt !== job.stage_updated_at || state.taskRevision !== job.task_revision) {
      db.prepare("UPDATE worktree_setup_requests SET status = 'stale', last_error = 'Task or stage changed' WHERE id = ?").run(job.id); return;
    }
    const run = readRun(env)!;
    const source = await bb.sdk.threads.get({ threadId: run.initiator_thread_id });
    const threads = (await hooks.listThreads(source.projectId)).filter(thread => thread.environmentId === env);
    if (job.status === "starting") {
      const orphan = threads.find(thread => job!.thread_id ? thread.id === job!.thread_id : (thread.title === title(job!) || thread.title === `Workflow setup [${job!.environment_id}:${job!.id}:${job!.attempts}]`));
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
    if (job.thread_id && ["pending", "started", "blocked"].includes(job.status)) {
      // Older versions queued a replacement after a worker failed or went idle.
      // Retain that assignment and allow its worker to submit a corrected plan.
      const worker = await bb.sdk.threads.get({ threadId: job.thread_id }).catch(() => null);
      if (!worker || worker.deletedAt || worker.archivedAt || worker.environmentId !== env) {
        db.prepare("UPDATE worktree_setup_requests SET last_error = 'Assigned setup worker is unavailable; inspect it before replacement' WHERE id = ?").run(job.id);
        return;
      }
      db.prepare("UPDATE worktree_setup_requests SET status = 'started', last_error = NULL WHERE id = ?").run(job.id);
      for (const thread of threads) {
        if (await waiting(thread)) return;
        if (thread.id !== run.initiator_thread_id && hooks.hasLiveWork(thread)) return;
      }
      if (worker.status === "error") {
        const id = job.id;
        await hooks.retryThread(worker.id, env, `setup:${id}`, () => {
          const current = latest(env);
          if (current?.id !== id || current.status !== "started" || current.thread_id !== worker.id) return false;
          try { fresh(current); return true; } catch { return false; }
        }, force);
      } else if (worker.status === "idle") {
        db.prepare("UPDATE worktree_setup_requests SET last_error = 'Setup worker is idle without a validated plan; continue in the same thread' WHERE id = ?").run(job.id);
      }
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
    const saved = hooks.choices().orchestrator;
    const reuseSource = await hooks.useInitiatingThread();
    if (reuseSource && hooks.hasLiveWork(source)) return;
    // The initiating thread keeps its harness; a saved choice for another harness applies only to a new thread.
    const differentProvider = reuseSource && saved?.providerId && saved.providerId !== source.providerId;
    const selected = saved?.providerId && !differentProvider
      ? await resolveStepExecution(bb.sdk, { environmentId: env, projectId: source.projectId }, {
          providerId: saved.providerId, model: saved.model ?? inheritedChoice.model,
          reasoningLevel: saved.reasoningLevel ?? inheritedChoice.reasoningLevel,
          skills: [], reason: "Use the Settings orchestrator choice.",
        } as Parameters<typeof resolveStepExecution>[2]) : inheritedChoice;
    const choice: typeof inheritedChoice = job.prepared_json ? JSON.parse(job.prepared_json) : {
      ...inheritedChoice, providerId: selected.providerId, model: selected.model, reasoningLevel: selected.reasoningLevel,
    };
    const context = fresh(job);
    const prompt = buildSetupPrompt({ environmentId: env, requestId: job.id, taskRevision: context.taskRevision,
      stage: context.stage, activeStepId: context.activeStepId, recoveryReason: job.reason, task: context.task!,
      stepChoices: stepChoices(context.task!.kind, hooks.choices()) });
    fresh(job);
    if (hooks.disposed()) return;
    const claim = db.prepare("UPDATE worktree_setup_requests SET status = 'starting', attempts = attempts + 1, updated_at = ?, prepared_json = ? WHERE id = ? AND status = 'pending' AND attempts = ?")
      .run(Date.now(), JSON.stringify(choice), job.id, job.attempts);
    if (claim.changes !== 1) return;
    job = latest(env)!;
    try {
      const coordinatorId = job.kind !== "initial" ? orchestrator(env) : (await hooks.useInitiatingThread()) ? source.id : null;
      let worker: { id: string };
      if (coordinatorId) {
        const coordinator = await bb.sdk.threads.get({ threadId: coordinatorId });
        if (!coordinator || coordinator.archivedAt || coordinator.deletedAt || coordinator.environmentId !== env) throw new Error("The saved orchestrator is unavailable. Keep the task for inspection.");
        db.prepare("UPDATE worktree_setup_requests SET thread_id = ? WHERE id = ?").run(coordinatorId, job.id);
        await bb.sdk.threads.send({ threadId: coordinatorId, mode: coordinator.status === "active" ? "steer" : "start", model: choice.model, reasoningLevel: choice.reasoningLevel, input: [{ type: "text", mentions: [], text: prompt }] });
        worker = coordinator;
      } else {
        worker = await bb.sdk.threads.spawn({ ...choice, projectId: source.projectId, parentThreadId: source.id,
          environment: { type: "reuse", environmentId: env }, visibility: "visible", title: title(job), prompt });
      }
      // A fast worker can apply its plan before the spawn response arrives.
      db.prepare("UPDATE worktree_setup_requests SET thread_id = ?, status = CASE WHEN status = 'starting' THEN 'started' ELSE status END WHERE id = ?")
        .run(worker.id, job.id);
    } catch (error) {
      if (!hooks.disposed()) db.prepare("UPDATE worktree_setup_requests SET last_error = ? WHERE id = ?")
        .run(String(error).slice(0, 1000), job.id);
      // Leave the starting claim intact until orphan lookup settles the uncertain spawn.
    }
  }
  async function tick(env: string, force = false) {
    if (locks.has(env)) return locks.get(env);
    const promise = tickUnlocked(env, force); locks.set(env, promise);
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
    const active = job.kind === "recovery" ? plan.steps.findIndex(step => step.id === context.activeStepId) : 0;
    requireStepChoices(context.task!.kind, plan.steps.slice(Math.max(0, active)), hooks.choices());
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
  async function tickAll(force = false) {
    const rows = db.prepare("SELECT environment_id FROM worktree_delivery_runs").all() as { environment_id: string }[];
    await Promise.all(rows.map(async row => { try { await tick(row.environment_id, force); } catch (error) { if (!hooks.disposed()) bb.log.error(`Setup recovery for ${row.environment_id}: ${String(error)}`); } }));
  }
  return { enqueue, reopen: (env: string, reason: string) => insert(env, "reopen", reason), openDesignGate, recover, apply, tick, tickAll, pending, isPlanner, latest, orchestrator, requestedTarget: (env: string) => { const run = readRun(env); return run ? (JSON.parse(run.request_json) as TaskContext).deliveryTarget : undefined; }, enabled: (env: string) => Boolean(readRun(env)),
    exhausted: (env: string) => (readRun(env)?.recovery_count ?? 0) >= 2 };
}
