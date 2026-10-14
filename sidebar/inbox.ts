import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

/**
 * The default sort for threads that the user has not placed yet. Activity
 * never changes it. A saved manual order takes over after the user drags.
 *
 * Ties break on id so the order is total and stable across renders.
 */
export function sortByCreatedAtDescending<
  T extends { readonly id: string; readonly createdAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

/**
 * New threads stay at the top until the user places them. Ranked threads then
 * follow their saved order. This lets a new thread remain easy to find without
 * throwing away the order the user made.
 */
export function sortByManualOrder<
  T extends { readonly id: string; readonly createdAt: number },
>(threads: readonly T[], order: ReadonlyMap<string, number>): T[] {
  return [...threads].sort((left, right) => {
    const leftOrder = order.get(left.id);
    const rightOrder = order.get(right.id);
    if (leftOrder === undefined && rightOrder === undefined) {
      return (
        right.createdAt - left.createdAt || left.id.localeCompare(right.id)
      );
    }
    if (leftOrder === undefined) return -1;
    if (rightOrder === undefined) return 1;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
}

export type DropPlacement = "before" | "after";

/** A root can move with roots. A child can move with the same parent's children. */
export function isThreadOrderPeer(
  left: Pick<PluginSidebarThread, "parentThreadId" | "isPinned">,
  right: Pick<PluginSidebarThread, "parentThreadId" | "isPinned">,
): boolean {
  return (
    left.parentThreadId === right.parentThreadId &&
    left.isPinned === right.isPinned
  );
}

/**
 * Move one thread beside a valid peer. Return the full pinned or unpinned
 * order so hidden rows and other parent groups keep their exact positions.
 */
export function moveThreadRelative(
  threads: readonly PluginSidebarThread[],
  sourceId: string,
  targetId: string,
  placement: DropPlacement,
): string[] | null {
  const source = threads.find((thread) => thread.id === sourceId);
  const target = threads.find((thread) => thread.id === targetId);
  if (!source || !target || !isThreadOrderPeer(source, target)) return null;

  const group = threads.filter((thread) => thread.isPinned === source.isPinned);
  const withoutSource = group.filter((thread) => thread.id !== sourceId);
  const targetIndex = withoutSource.findIndex(
    (thread) => thread.id === targetId,
  );
  if (targetIndex < 0) return group.map((thread) => thread.id);
  withoutSource.splice(
    targetIndex + (placement === "after" ? 1 : 0),
    0,
    source,
  );
  return withoutSource.map((thread) => thread.id);
}

export function threadDisplayTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/** Substring match on the visible title only, preserving the incoming order. */
export function searchThreadsByTitle(
  threads: readonly PluginSidebarThread[],
  query: string,
): PluginSidebarThread[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...threads];
  return threads.filter((thread) =>
    threadDisplayTitle(thread).toLowerCase().includes(normalized),
  );
}

export interface ProjectScope {
  /** Project id, or null for "all projects". */
  id: string | null;
  name: string;
}

/** Threads in the chosen scope; every thread when the scope is null. */
export function filterByProject(
  threads: readonly PluginSidebarThread[],
  projectId: string | null,
): PluginSidebarThread[] {
  if (projectId === null) return [...threads];
  return threads.filter((thread) => thread.projectId === projectId);
}

/** Archived threads never belong in the inbox. */
export function visibleInboxThreads(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived);
}

/** Pinned first (they are the user's own ordering), then the static sort. */
export function partitionPinned(threads: readonly PluginSidebarThread[]): {
  pinned: PluginSidebarThread[];
  inbox: PluginSidebarThread[];
} {
  const pinned: PluginSidebarThread[] = [];
  const inbox: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (thread.isPinned ? pinned : inbox).push(thread);
  }
  return { pinned, inbox };
}

/**
 * The parent of one thread, or null when the thread is a root, when the id is
 * unknown, or when the parent row is gone (deleted). The parent may be
 * archived or in another project: the flat list hides those, but the child
 * still needs a way back to them.
 */
export function parentOf(
  threads: readonly PluginSidebarThread[],
  threadId: string,
): PluginSidebarThread | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const parentThreadId = thread?.parentThreadId;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}

/** The children of one thread, oldest first (the order they were spawned). */
export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
