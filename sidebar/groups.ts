import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { sortByManualOrder } from "./inbox";
import type { ThreadShelf } from "./lifecycle";

export function worktreeKey(thread: PluginSidebarThread): string | null {
  const env = thread.environment;
  return env?.id &&
    (env.workspaceDisplayKind === "managed-worktree" ||
      env.workspaceDisplayKind === "unmanaged-worktree")
    ? JSON.stringify([thread.projectId, env.id])
    : null;
}

export interface ThreadGroup {
  id: string;
  worktree: boolean;
  main: PluginSidebarThread;
  members: PluginSidebarThread[];
  shelf: ThreadShelf;
  pinned: boolean;
  createdAt: number;
}

export function buildGroups(
  threads: readonly PluginSidebarThread[],
  mains: ReadonlyMap<string, string>,
  preferred: ReadonlyMap<string, string>,
  order: ReadonlyMap<string, number>,
  shelfFor: (thread: PluginSidebarThread) => ThreadShelf,
): ThreadGroup[] {
  const buckets = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    if (thread.isArchived) continue;
    const id = worktreeKey(thread) ?? thread.id;
    const members = buckets.get(id) ?? [];
    members.push(thread);
    buckets.set(id, members);
  }
  return [...buckets].map(([id, members]) => {
    const byAge = [...members].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
    const byId = new Map(members.map((t) => [t.id, t]));
    const candidate =
      members.find((t) => t.id === mains.get(id)) ??
      members.find((t) => t.id === preferred.get(id)) ??
      byAge.find((t) => !t.parentThreadId || !byId.has(t.parentThreadId)) ??
      byAge[0]!;
    // The Main Thread is a root of the group; a parent cycle keeps the candidate.
    let main = candidate;
    for (const seen = new Set<string>(); main.parentThreadId; ) {
      const parent = byId.get(main.parentThreadId);
      if (!parent) break;
      if (seen.has(main.id)) {
        main = candidate;
        break;
      }
      seen.add(main.id);
      main = parent;
    }
    const shelves = members.map(shelfFor);
    return {
      id,
      worktree: worktreeKey(main) !== null,
      main,
      members: sortByManualOrder(members, order).sort(
        (a, b) => Number(b.isPinned) - Number(a.isPinned),
      ),
      shelf: shelves.includes("active")
        ? "active"
        : shelves.includes("snoozed")
          ? "snoozed"
          : "settled",
      pinned: members.some((t) => t.isPinned),
      createdAt: Math.min(...members.map((t) => t.createdAt)),
    };
  });
}

export function groupAttentionItems(threads: readonly PluginSidebarThread[]) {
  let input = 0,
    failed = 0,
    running = 0,
    unread = 0;
  for (const t of threads) {
    if (t.hasPendingInteraction || t.indicator === "waiting-for-input") input++;
    if (t.indicator === "unread-error") failed++;
    if (
      t.indicator === "runtime" ||
      t.indicator === "working-draft" ||
      Object.values(t.activity).some((n) => n > 0)
    )
      running++;
    if (t.isUnread) unread++;
  }
  return [
    { kind: "input", count: input, label: `${input} needs input` },
    { kind: "failed", count: failed, label: `${failed} failed` },
    { kind: "running", count: running, label: `${running} running` },
    { kind: "unread", count: unread, label: `${unread} unread` },
  ].filter((item) => item.count > 0);
}

export function groupAttention(threads: readonly PluginSidebarThread[]) {
  return groupAttentionItems(threads)
    .map((item) => item.label)
    .join(" · ");
}

export function moveRelative(
  ids: readonly string[],
  source: string,
  target: string,
  after: boolean,
): string[] | null {
  if (source === target || !ids.includes(source) || !ids.includes(target))
    return null;
  const next = ids.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}
