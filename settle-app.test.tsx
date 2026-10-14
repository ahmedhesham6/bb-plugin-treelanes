// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { STAGES } from "./workflow";

function board(stage: "design" | "quality" | "review", settled = false) {
  return { stages: [...STAGES], cards: settled ? [] : [{
    environmentId: "environment-one", projectId: "project-one", projectName: "Test project",
    worktreeName: "settle-worktree", branchName: "feat/settle", stage, note: null,
    status: "idle", hasPendingInteraction: false, updatedAt: 2, stageUpdatedAt: 1,
    pendingThreadStart: null,
    threads: [{ id: "thread-child", title: "Finished child", status: "idle", updatedAt: 2,
      parentThreadId: "thread-root", hasPendingInteraction: false, canSettle: true }],
  }] };
}

describe("Settle from Workflow Board", () => {
  it.each(["design", "quality", "review"] as const)("settles from %s without opening the thread and removes the empty card", async (stage) => {
    const app = await loadPluginApp(() => import("./app"));
    let settled = false;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: "project-one", threadId: null },
      rpc: {
        getBoard: () => board(stage, settled),
        settleThread: async () => { await pending; settled = true; return { ok: true }; },
      },
    });
    try {
      const button = await slot.findByRole("button", { name: "Settle Finished child" });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "settleThread")).toEqual([
        { method: "settleThread", input: { threadId: "thread-child" } },
      ]);
      expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
      expect(slot.inspection.navigateCalls).toHaveLength(0);
      finish();
      await waitFor(() => expect(slot.queryByText("settle-worktree")).toBeNull());
    } finally { slot.lifecycle.unmount(); }
  });

  it("keeps a thread visible after a failed settle and lets the user retry", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: "project-one", threadId: null },
      rpc: {
        getBoard: () => board("design"),
        settleThread: () => { throw new Error("T3 Sidebar unavailable"); },
      },
    });
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Settle Finished child" }));
      expect((await slot.findByRole("alert")).textContent).toBe("T3 Sidebar unavailable");
      expect(slot.getByRole("button", { name: "Finished child" })).toBeTruthy();
      expect((slot.getByRole("button", { name: "Settle Finished child" }) as HTMLButtonElement).disabled).toBe(false);
      expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    } finally { slot.lifecycle.unmount(); }
  });

  it("disables settle when the server reports live work or a pending question", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const result = board("design");
    result.cards[0]!.threads[0]!.canSettle = false;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: "project-one", threadId: null },
      rpc: { getBoard: () => result },
    });
    try {
      const button = await slot.findByRole("button", { name: "Settle Finished child" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "settleThread")).toHaveLength(0);
    } finally { slot.lifecycle.unmount(); }
  });
});
