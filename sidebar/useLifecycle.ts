import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { sidebarRpcContract } from "./server";
import {
  canPark,
  nextWakeDelayMs,
  resolveShelf,
  type ThreadLifecycleRow,
  type ThreadShelf,
} from "./lifecycle";

/** Any live work at all, which blocks parking and wakes a parked thread. */
export function isWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft"
  );
}

export interface LifecycleApi {
  status: string;
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  canPark(thread: PluginSidebarThread): boolean;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  settle(threadId: string, includeWorktree?: boolean): void;
  unsettle(threadId: string): void;
  snooze(threadId: string, snoozedUntil: number): void;
  unsnooze(threadId: string): void;
}

/**
 * Reads the plugin's own lifecycle store and classifies threads onto shelves.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 */
export function useLifecycle(
  threads: readonly PluginSidebarThread[],
): LifecycleApi {
  const rpc = useRpc<typeof sidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [status, setStatus] = useState("loading");
  const [rows, setRows] = useState<ReadonlyMap<string, ThreadLifecycleRow>>(
    () => new Map(),
  );
  const [now, setNow] = useState(() => Date.now());

  // Responses can land out of order (a mutation's refresh racing a realtime
  // one), and an older list would silently restore state the user just
  // changed. Only the newest request may write.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listLifecycle", {});
      if (seq !== requestSeq.current) return;
      setRows(new Map(result.rows.map((row) => [row.threadId, row])));
      setNow(Date.now());
      setStatus("ready");
    } catch {
      if (seq === requestSeq.current) setStatus("error");
    }
  }, [rpc]);

  useEffect(() => {
    if (connection === "connected") void refresh();
    return () => {
      requestSeq.current++;
    };
  }, [refresh, connection]);

  useRealtime("lifecycle", () => {
    void refresh();
  });

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const delay = nextWakeDelayMs(
      [...rows.values()].flatMap((row) =>
        row.snoozedUntil === null ? [] : [row.snoozedUntil],
      ),
      armedAt,
    );
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, rows]);

  return useMemo<LifecycleApi>(() => {
    const signalsFor = (thread: PluginSidebarThread) => ({
      hasPendingInteraction: thread.hasPendingInteraction,
      isWorking: isWorking(thread),
      isUnread: thread.isUnread,
      latestAttentionAt: thread.latestAttentionAt,
    });
    // One read per mutation: the write publishes on the realtime channel, and
    // that subscription already triggers a refresh for every client.
    const mutate = async (
      method: "settle" | "unsettle" | "unsnooze",
      threadId: string,
      includeWorktree?: boolean,
    ) => {
      try {
        await rpc.call(method, {
          threadId,
          ...(includeWorktree ? { includeWorktree } : {}),
        });
        await refresh();
      } catch {
        toast.error("Could not update the thread. Try again.");
      }
    };
    return {
      status,
      shelfFor: (thread) =>
        resolveShelf(rows.get(thread.id), signalsFor(thread), now),
      canPark: (thread) => canPark(signalsFor(thread)),
      wakeAtFor: (thread) => rows.get(thread.id)?.snoozedUntil ?? null,
      settle: (threadId, includeWorktree) =>
        void mutate("settle", threadId, includeWorktree),
      unsettle: (threadId) => void mutate("unsettle", threadId),
      unsnooze: (threadId) => void mutate("unsnooze", threadId),
      snooze: (threadId, snoozedUntil) => {
        void rpc
          .call("snooze", { threadId, snoozedUntil })
          .then(refresh)
          .catch(() => toast.error("Could not snooze the thread. Try again."));
      },
    };
  }, [now, refresh, rows, rpc, status]);
}
