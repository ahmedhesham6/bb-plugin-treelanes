// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { project } from "./test-fixtures";

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime.
const app = await loadPluginApp(() => import("../app"));
const parentChip = app.threadHeaderRows.find((slot) => slot.id === "parent")!;

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    displayTitle: "A thread",
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    pinnedAt: null,
    pinSortKey: null,
    archivedAt: null,
    href: "/projects/proj_1/threads/thr_1",
    isHidden: false,
    ...overrides,
  };
}

function render(threads: PluginSidebarThread[], threadId: string) {
  return renderSlot(
    parentChip,
    { threadId, projectId: "proj_1", environment: null },
    {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [project("proj_1", "bb")],
      },
    },
  );
}

afterEach(cleanup);

describe("ParentChip", () => {
  // The whole reason the chip exists: the list hides the child, so this is its
  // only route back.
  it("opens the parent on click", () => {
    const rendered = render(
      [
        thread({ id: "parent", title: "Parent thread" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    fireEvent.click(screen.getByRole("button"));
    expect(rendered.navigateCalls).toEqual([
      { method: "toThread", threadId: "parent" },
    ]);
  });

  // Children come after the way back to the parent.
  it("puts the parent row before the child row", () => {
    const order = (id: string) =>
      app.threadHeaderRows.find((slot) => slot.id === id)!.order!;
    expect(app.threadHeaderRows.map((slot) => slot.id)).toEqual([
      "parent",
      "children",
    ]);
    expect(order("parent")).toBeLessThan(order("children"));
  });

  it("renders nothing on a root thread", () => {
    render([thread({ id: "root" })], "root");
    expect(screen.queryByRole("button")).toBeNull();
  });

  // An archived parent is out of the list but still the way back.
  it("names an archived parent", () => {
    render(
      [
        thread({ id: "parent", title: "Archived parent", isArchived: true }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Back to parent: Archived parent",
    );
  });

  // A phone shows the chevron and the disc only, but the control keeps its
  // name. bb gives a header row no viewport prop, so CSS hides the title.
  it("hides the title on a compact viewport", () => {
    render(
      [
        thread({ id: "parent", title: "Parent thread" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    const button = screen.getByRole("button");
    expect(screen.getByText("Parent thread").className.split(" ")).toEqual(
      expect.arrayContaining(["max-sm:hidden", "pointer-coarse:hidden"]),
    );
    expect(button.getAttribute("aria-label")).toBe(
      "Back to parent: Parent thread",
    );
  });
});
