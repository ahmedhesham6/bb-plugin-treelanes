import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useThreads,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { sidebarRpcContract } from "./server";
import { withGeneratedTitle, type GeneratedTitle } from "./display-title";

let cached: GeneratedTitle[] = [];
export function useTitledThreads() {
  const source = useThreads();
  const rpc = useRpc<typeof sidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [titles, setTitles] = useState(cached);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++seq.current;
    try {
      const result = await rpc.call("listTitles", {});
      if (request !== seq.current) return;
      cached = result.rows;
      setTitles(result.rows);
    } catch {
      /* Names are optional. Keep the current list on a connection error. */
    }
  }, [rpc]);
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
  return { ...source, threads };
}
