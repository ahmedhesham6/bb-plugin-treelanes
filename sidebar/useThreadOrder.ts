import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { sidebarRpcContract } from "./server";

export interface ThreadOrderApi {
  status: string;
  order: ReadonlyMap<string, number>;
  save(threadIds: readonly string[]): void;
}

/** Read and update the manual order kept in the plugin database. */
export function useThreadOrder(): ThreadOrderApi {
  const rpc = useRpc<typeof sidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [status, setStatus] = useState("loading");
  const [order, setOrder] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listOrder", {});
      if (seq !== requestSeq.current) return;
      setOrder(
        new Map(result.rows.map((row) => [row.threadId, row.sortOrder])),
      );
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

  useRealtime("order", () => {
    void refresh();
  });

  return useMemo(
    () => ({
      status,
      order,
      save(threadIds: readonly string[]) {
        const optimistic = new Map(order);
        threadIds.forEach((threadId, index) => optimistic.set(threadId, index));
        setOrder(optimistic);
        void rpc
          .call("saveOrder", { threadIds: [...threadIds] })
          .then(refresh)
          .catch(() => {
            setOrder(order);
            toast.error("Could not save thread order. Try again.");
          });
      },
    }),
    [order, rpc, refresh, status],
  );
}
