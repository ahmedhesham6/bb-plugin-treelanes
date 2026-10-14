import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { setTimeout as delay } from "node:timers/promises";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

// BB's sidebar hook and row actions only accept visible threads. Reveal linked
// agent children through the host API so those actions and live status work.
export function childVisibility(bb: BbPluginApi) {
  let busy = false;
  async function run(signal?: AbortSignal) {
    if (busy) return;
    busy = true;
    try {
      const threads = new Map<string, Thread>();
      for (let offset = 0; ; offset += 200) {
        const page = await bb.sdk.threads.list({
          archived: false, includeHidden: true, limit: 200, offset, signal,
        });
        for (const thread of page) threads.set(thread.id, thread);
        if (page.length < 200) break;
      }
      function linkedToVisibleThread(thread: Thread): boolean {
        const seen = new Set<string>();
        let current: Thread | undefined = thread;
        while (current) {
          if (seen.has(current.id) || current.archivedAt || current.deletedAt ||
            current.projectId !== thread.projectId || current.environmentId !== thread.environmentId)
            return false;
          seen.add(current.id);
          if (current.visibility === "visible") return true;
          // Hidden plugin workers, such as board setup workers, are internal.
          if (current.originPluginId) return false;
          current = current.parentThreadId ? threads.get(current.parentThreadId) : undefined;
        }
        return false;
      }
      for (const thread of threads.values()) {
        if (thread.visibility !== "hidden" || !thread.environmentId ||
          !["managed-worktree", "unmanaged-worktree"].includes(thread.environmentWorkspaceDisplayKind) ||
          !linkedToVisibleThread(thread)) continue;
        signal?.throwIfAborted();
        const current = await bb.sdk.threads.get({ threadId: thread.id, signal });
        if (current.visibility !== "hidden" || current.archivedAt || current.deletedAt ||
          current.originPluginId || current.parentThreadId !== thread.parentThreadId ||
          current.environmentId !== thread.environmentId || current.projectId !== thread.projectId)
          continue;
        await bb.sdk.threads.update({ threadId: thread.id, visibility: "visible" });
      }
    } finally {
      busy = false;
    }
  }
  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.visibility === "hidden" && thread.parentThreadId && !thread.originPluginId)
      await run();
  });
  bb.background.service("child-visibility", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await run(signal);
        } catch (error) {
          if (!signal.aborted)
            bb.log.warn("Child visibility: " + (error instanceof Error ? error.message : "failed"));
        }
        try {
          await delay(60_000, undefined, { signal });
        } catch {
          break;
        }
      }
    },
  });
  return { run };
}
