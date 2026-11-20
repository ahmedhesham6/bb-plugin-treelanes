import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useThreads,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { sidebarRpcContract } from "./server";
import {
  TITLE_BATCH,
  isAutomaticTitle,
  withGeneratedTitle,
  type GeneratedTitle,
} from "./display-title";

let cached: GeneratedTitle[] = [];
export function useTitledThreads() {
  const source = useThreads();
  const rpc = useRpc<typeof sidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [titles, setTitles] = useState(cached);
  const seq = useRef(0);
  const workerIds = useMemo(
    () =>
      source.threads
        .filter(isAutomaticTitle)
        .map((thread) => thread.id)
        .sort(),
    [source.threads],
  );
  const workerKey = workerIds.join(" ");
  const refresh = useCallback(async () => {
    const request = ++seq.current;
    try {
      const ids = workerKey ? workerKey.split(" ") : [];
      const rows: GeneratedTitle[] = [];
      for (let start = 0; start < ids.length; start += TITLE_BATCH) {
        const result = await rpc.call("listTitles", {
          threadIds: ids.slice(start, start + TITLE_BATCH),
        });
        rows.push(...result.rows);
      }
      if (request !== seq.current) return;
      cached = rows;
      setTitles(rows);
    } catch {
      /* Names are optional. Keep the current list on a connection error. */
    }
  }, [rpc, workerKey]);
  useEffect(() => {
    if (connection === "connected") void refresh();
    return () => {
      seq.current++;
    };
  }, [connection, refresh]);
  useRealtime("titles", () => {
    void refresh();
  });
  const threads = useMemo(() => {
    const byId = new Map(titles.map((row) => [row.threadId, row]));
    return source.threads.map((thread) =>
      withGeneratedTitle(thread, byId.get(thread.id)),
    );
  }, [source.threads, titles]);
  const boardWorkers = useMemo(() => new Set(workerIds), [workerIds]);
  return { ...source, threads, boardWorkers };
}
