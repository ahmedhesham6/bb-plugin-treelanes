import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { sidebarRpcContract } from "./server";
import type { ThreadGroup } from "./groups";

type SavedMain = { projectId: string; environmentId: string; threadId: string };
const toMap = (rows: SavedMain[]) =>
  new Map(
    rows.map((row) => [
      JSON.stringify([row.projectId, row.environmentId]),
      row.threadId,
    ]),
  );
export function useGroups() {
  const rpc = useRpc<typeof sidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState({
    mains: new Map<string, string>(),
    preferred: new Map<string, string>(),
    order: new Map<string, number>(),
    status: "loading",
  });
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++seq.current;
    try {
      const result = await rpc.call("listGroups", {});
      if (current === seq.current)
        setState({
          mains: toMap(result.mains),
          preferred: toMap(result.preferred),
          order: new Map(result.order.map((r) => [r.groupId, r.sortOrder])),
          status: "ready",
        });
    } catch {
      if (current === seq.current) setState((s) => ({ ...s, status: "error" }));
    }
  }, [rpc]);
  useEffect(() => {
    if (connection === "connected") void refresh();
    return () => {
      seq.current++;
    };
  }, [refresh, connection]);
  useRealtime("groups", () => {
    void refresh();
  });
  const saveMain = useCallback(
    async (group: ThreadGroup, threadId: string) => {
      if (!group.worktree || !group.main.environment?.id) return;
      try {
        await rpc.call("saveMain", {
          projectId: group.main.projectId,
          environmentId: group.main.environment.id,
          threadId,
          expectedThreadId: state.mains.get(group.id) ?? null,
        });
        await refresh();
      } catch {
        toast.error("Could not save the main thread. Try again.");
      }
    },
    [rpc, refresh, state.mains],
  );
  const saveOrder = async (groupIds: string[]) => {
    try {
      await rpc.call("saveGroupOrder", { groupIds });
      await refresh();
    } catch {
      toast.error("Could not save worktree order. Try again.");
    }
  };
  return { ...state, refresh, saveMain, saveOrder };
}
