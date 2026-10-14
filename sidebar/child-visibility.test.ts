import { expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { childVisibility } from "./child-visibility";

it("reveals linked agent descendants, keeps internal and unrelated threads hidden, and handles new children", async () => {
  const rows = [
    makeThreadResponse({ id: "deep", parentThreadId: "review", visibility: "hidden" }),
    makeThreadResponse({ id: "review", parentThreadId: "root", visibility: "hidden" }),
    makeThreadResponse({ id: "root", visibility: "visible" }),
    makeThreadResponse({ id: "setup", parentThreadId: "root", visibility: "hidden", originPluginId: "workflow-board" }),
    makeThreadResponse({ id: "orphan", parentThreadId: "missing", visibility: "hidden" }),
    makeThreadResponse({ id: "cycle", parentThreadId: "cycle", visibility: "hidden" }),
    makeThreadResponse({ id: "other-env", parentThreadId: "root", visibility: "hidden" }),
  ].map((t) => ({ ...t, projectId: "p", environmentId: t.id === "other-env" ? "other" : "e",
    environmentWorkspaceDisplayKind: "managed-worktree" }));
  const updated: string[] = [];
  const host = createFakePluginHost({ sdk: { threads: {
    list: async () => rows as never,
    get: async ({ threadId }) => rows.find((t) => t.id === threadId)!,
    update: async ({ threadId }) => {
      updated.push(threadId);
      rows.find((t) => t.id === threadId)!.visibility = "visible";
      return { ok: true } as never;
    },
  } } });
  try {
    const visibility = childVisibility(host.bb);
    await visibility.run();
    expect(updated).toEqual(["deep", "review"]);
    const next = { ...rows[1]!, id: "next", visibility: "hidden" as const };
    rows.push(next);
    await host.harness.behavior.emitThreadEvent("thread.created", { thread: next });
    expect(updated).toEqual(["deep", "review", "next"]);
    await visibility.run();
    expect(updated).toHaveLength(3);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
