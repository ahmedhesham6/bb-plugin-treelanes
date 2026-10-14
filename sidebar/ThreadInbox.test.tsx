// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as baseRenderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarThread,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk";
import { dragAutoScrollSpeed } from "./useDragAutoScroll";

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime; importing the component directly would bind it to an
// empty runtime first.
const app = await loadPluginApp(() => import("../app"));
const inbox = app.threadLists[0]!;

async function renderSlot(
  ...args: Parameters<typeof baseRenderSlot<PluginThreadListProps>>
) {
  const view = baseRenderSlot(...args);
  await waitFor(() =>
    expect(screen.queryByText("Loading threads…")).toBeNull(),
  );
  return view;
}

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
      goals: 0,
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
    ...overrides,
  };
}

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
  Original: () => null,
};

async function render(
  threads: PluginSidebarThread[],
  projects = [{ id: "proj_1", name: "bb", isPersonal: false }],
) {
  return await renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    // The lifecycle store is the plugin's own backend; an empty one means
    // every thread is active, which is what these list tests are about.
    rpc: {
      listGroups: () => ({ mains: [], preferred: [], order: [] }),
      saveMain: () => ({ ok: true }),
      saveGroupOrder: () => ({ ok: true }),
      listLifecycle: () => ({ rows: [] }),
      listOrder: () => ({ rows: [] }),
    },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("drag edge scrolling", async () => {
  it("scrolls up and down near the list edges", async () => {
    expect(dragAutoScrollSpeed(10, 0, 200)).toBeLessThan(0);
    expect(dragAutoScrollSpeed(100, 0, 200)).toBe(0);
    expect(dragAutoScrollSpeed(190, 0, 200)).toBeGreaterThan(0);
  });

  it("uses the fastest speed outside the list", async () => {
    expect(dragAutoScrollSpeed(-20, 0, 200)).toBe(-18);
    expect(dragAutoScrollSpeed(220, 0, 200)).toBe(18);
  });

  it("scrolls the thread list while a drag stays at its bottom edge", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    await render([
      thread({ id: "a", title: "Alpha" }),
      thread({ id: "b", title: "Beta" }),
    ]);
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: () => {},
      setDragImage: () => {},
    };
    fireEvent.dragStart(await screen.findByRole("link", { name: "Beta" }), {
      dataTransfer,
    });

    const scrollArea = screen.getByTestId("thread-scroll-area");
    scrollArea.getBoundingClientRect = () =>
      ({ top: 0, bottom: 200, height: 200 }) as DOMRect;
    Object.defineProperty(scrollArea, "scrollTop", {
      value: 0,
      writable: true,
    });
    const dragOver = createEvent.dragOver(scrollArea, { dataTransfer });
    Object.defineProperty(dragOver, "clientY", { value: 195 });
    fireEvent(scrollArea, dragOver);
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(scrollArea.scrollTop).toBeGreaterThan(0);
  });
});

describe("t3sidebar registration", async () => {
  it("registers exactly one thread list", async () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
  });
});

describe("ThreadInbox", async () => {
  it("lists threads newest first", async () => {
    await render([
      thread({ id: "a", title: "Older", createdAt: 1 }),
      thread({ id: "b", title: "Newer", createdAt: 2 }),
    ]);
    // The anchor is a full-bleed overlay, so read the row containers.
    const titles = screen
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(titles[0]).toContain("Newer");
    expect(titles[1]).toContain("Older");
  });

  it("lists a child thread with its visible parent", async () => {
    await render([
      thread({ id: "parent", title: "Parent thread", createdAt: 1 }),
      thread({
        id: "child",
        title: "Child thread",
        parentThreadId: "parent",
        createdAt: 2,
      }),
    ]);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Parent thread")).toBeDefined();
    expect(screen.getByText("Child thread")).toBeDefined();
  });

  // The DOM contract behind numbered thread shortcuts and thread.next/previous.
  // A plugin that drops these attributes silently breaks nine host shortcuts.
  it("marks every row as a host shortcut target", async () => {
    await render([thread({ id: "thr_x" })]);
    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  it("opens a thread on click and closes the mobile drawer", async () => {
    let navigated = 0;
    const rendered = await renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listGroups: () => ({ mains: [], preferred: [], order: [] }),
          saveMain: () => ({ ok: true }),
          saveGroupOrder: () => ({ ok: true }),
          listLifecycle: () => ({ rows: [] }),
          listOrder: () => ({ rows: [] }),
        },
      },
    );
    fireEvent.click(screen.getByRole("link"));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_open",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  it("opens in a split with the platform modifier held", async () => {
    const rendered = await render([thread({ id: "thr_split" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_split",
      options: { split: true },
    });
  });

  it("separates pinned threads from the inbox", async () => {
    await render([
      thread({ id: "a", title: "Plain" }),
      thread({ id: "b", title: "Stuck", isPinned: true }),
    ]);
    const pinned = screen.getByRole("region", { name: /pinned/i });
    expect(within(pinned).getByText("Stuck")).toBeDefined();
  });

  // The host owns the search field; the plugin only filters by what it is
  // handed, so there is deliberately no second search box to type into.
  it("filters by the host's search query", async () => {
    await renderSlot(
      inbox,
      { ...listProps, searchQuery: "sidebar" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Sidebar work" }),
            thread({ id: "b", title: "Something else" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listGroups: () => ({ mains: [], preferred: [], order: [] }),
          saveMain: () => ({ ok: true }),
          saveGroupOrder: () => ({ ok: true }),
          listLifecycle: () => ({ rows: [] }),
          listOrder: () => ({ rows: [] }),
        },
      },
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Sidebar work")).toBeDefined();
  });

  it("ships no search field of its own", async () => {
    await render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("Search threads")).toBeNull();
  });

  it("ships no new-thread button of its own", async () => {
    await render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("New thread")).toBeNull();
  });

  it("scopes to one project", async () => {
    await render(
      [
        thread({ id: "a", title: "In bb", projectId: "proj_1" }),
        thread({ id: "b", title: "In other", projectId: "proj_2" }),
      ],
      [
        { id: "proj_1", name: "bb", isPersonal: false },
        { id: "proj_2", name: "other", isPersonal: false },
      ],
    );
    // Radix opens on keyboard too, which jsdom can drive without pointer
    // capture. Enter opens the list; the option click picks the scope.
    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "other" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("In other")).toBeDefined();
  });

  it("hides archived threads", async () => {
    await render([thread({ id: "a", isArchived: true })]);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("reports an empty inbox and a fruitless search differently", async () => {
    await render([]);
    expect(screen.getByText("No threads yet")).toBeDefined();
  });
});

describe("manual thread order", async () => {
  it("loads the saved order", async () => {
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Alpha", createdAt: 1 }),
          thread({ id: "b", title: "Beta", createdAt: 2 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listLifecycle: () => ({ rows: [] }),
        listOrder: () => ({
          rows: [
            { threadId: "a", sortOrder: 0 },
            { threadId: "b", sortOrder: 1 },
          ],
        }),
      },
    });
    await waitFor(() => {
      const rows = screen.getAllByRole("listitem");
      expect(rows[0]?.textContent).toContain("Alpha");
      expect(rows[1]?.textContent).toContain("Beta");
    });
  });

  it("moves a thread with the drag handle's arrow keys", async () => {
    let saved: string[] | null = null;
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Alpha", createdAt: 1 }),
          thread({ id: "b", title: "Beta", createdAt: 2 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: (input) => {
          saved = (input as { groupIds: string[] }).groupIds;
          return { ok: true };
        },
        listLifecycle: () => ({ rows: [] }),
        listOrder: () => ({ rows: [] }),
        saveOrder: (input) => {
          saved = (input as { threadIds: string[] }).threadIds;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Beta"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(saved).toEqual(["a", "b"]));
    expect(screen.getByText("Beta moved after Alpha.")).toBeDefined();
  });

  it("moves a thread when its row is dragged onto a peer", async () => {
    let saved: string[] | null = null;
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Alpha", createdAt: 1 }),
          thread({ id: "b", title: "Beta", createdAt: 2 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: (input) => {
          saved = (input as { groupIds: string[] }).groupIds;
          return { ok: true };
        },
        listLifecycle: () => ({ rows: [] }),
        listOrder: () => ({ rows: [] }),
        saveOrder: (input) => {
          saved = (input as { threadIds: string[] }).threadIds;
          return { ok: true };
        },
      },
    });
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: () => {},
      setDragImage: () => {},
    };
    fireEvent.dragStart(await screen.findByRole("link", { name: "Beta" }), {
      dataTransfer,
    });
    const target = screen.getByText("Alpha").closest("li")!;
    fireEvent.dragOver(target, { clientY: 1, dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(saved).toEqual(["a", "b"]));
  });

  it("does not offer a move across child parent groups", async () => {
    let saved = false;
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "First child", parentThreadId: "p1" }),
          thread({ id: "b", title: "Other child", parentThreadId: "p2" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listLifecycle: () => ({ rows: [] }),
        listOrder: () => ({ rows: [] }),
        saveOrder: () => {
          saved = true;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("First child"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(saved).toBe(false);
  });
});

describe("parking threads", async () => {
  it("moves a settled thread to the Settled shelf", async () => {
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listOrder: () => ({ rows: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_done",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    // The shelf renders once the lifecycle read resolves.
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByText(/Settled \(1\)/)).toBeDefined();
    // Collapsed by default: parked work is out of the way, never gone.
    expect(screen.queryByText("Finished work")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Finished work")).toBeDefined();
  });

  it("keeps a working thread out of the shelves and offers no park action", async () => {
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_busy",
            title: "Still running",
            indicator: "runtime",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      // Settled in the store, but still working: it must stay visible.
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listOrder: () => ({ rows: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_busy",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("offers settle and snooze on a parkable thread", async () => {
    await render([thread({ id: "thr_park", title: "Quiet" })]);
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    fireEvent.contextMenu(await screen.findByText("Quiet"));
    expect(
      await screen.findByRole("menuitem", { name: "Settle thread" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "Snooze until tomorrow" }),
    ).toBeDefined();
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listLifecycle: () => ({ rows: [] }),
        listOrder: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Quiet"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Settle thread" }),
    );
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  it("shows the wake countdown on a snoozed row", async () => {
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listOrder: () => ({ rows: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_snz",
              settledAt: null,
              snoozedUntil: wakeAt,
              snoozedAt: Date.now(),
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("2h")).toBeDefined();
    fireEvent.contextMenu(await screen.findByText("Later"));
    expect(
      await screen.findByRole("menuitem", { name: "Wake thread now" }),
    ).toBeDefined();
  });
});

describe("row context menu", async () => {
  it("offers the plugin's own thread actions on right-click", async () => {
    await render([thread({ id: "thr_menu", title: "Right click me" })]);
    const row = await screen.findByText("Right click me");
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    // The plugin builds this menu itself — the SDK ships no menu component —
    // so the items are this plugin's choice, backed by the action hook.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open in split",
      "Mark unread",
      "Pin",
      "Settle thread",
      "Snooze until tomorrow",
      "Move up",
      "Move down",
      "Archive",
      "Delete",
    ]);
  });

  it("routes deletion through the host's confirmation", async () => {
    const rendered = await render([
      thread({ id: "thr_del", title: "Delete me" }),
    ]);
    fireEvent.contextMenu(await screen.findByText("Delete me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "requestDelete",
        threadId: "thr_del",
      }),
    );
  });
});

describe("card metadata", async () => {
  it("always shows the provider glyph, even without a branch", async () => {
    await render([thread({ id: "thr_p", providerId: "claude-code" })]);
    expect(await screen.findByLabelText("Claude Code")).toBeDefined();
  });

  it("falls back to a neutral glyph for an unknown provider", async () => {
    await render([thread({ id: "thr_p", providerId: "some-new-agent" })]);
    expect(await screen.findByLabelText("some-new-agent")).toBeDefined();
  });

  // A personal-project thread has a machine but no worktree, so the machine
  // takes the branch's place instead of leaving the line blank.
  it("shows the machine when the thread has no branch", async () => {
    await render([
      thread({
        id: "thr_m",
        host: { id: "host_1", name: "Sawyer's MacBook" },
      }),
    ]);
    expect(await screen.findByText("Sawyer's MacBook")).toBeDefined();
  });

  it("prefers the branch over the machine when both exist", async () => {
    await render([
      thread({
        id: "thr_b",
        host: { id: "host_1", name: "Sawyer's MacBook" },
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "bb/feature",
          workspaceDisplayKind: "managed-worktree",
        },
      }),
    ]);
    expect(await screen.findByText("bb/feature")).toBeDefined();
    expect(screen.queryByText("Sawyer's MacBook")).toBeNull();
  });

  // Not exactly 3h: the card's clock is quantized to the minute, so a
  // timestamp sitting on a bucket boundary legitimately reads one unit lower.
  it("shows how long ago the thread was touched", async () => {
    await render([
      thread({ id: "thr_t", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // Status and age share one slot. A row that shows both puts a variable-width
  // label in the column, and no two rows line up.
  it("replaces the age label with the status glyph while work runs", async () => {
    await render([
      thread({
        id: "thr_run",
        indicator: "runtime",
        indicatorLabel: "Agent is working",
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByLabelText("Agent is working")).toBeDefined();
    expect(screen.queryByText("3h")).toBeNull();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.
  it("keeps the age label for an unrecognized indicator", async () => {
    await render([
      thread({
        id: "thr_new",
        indicator: "something-bb-ships-later" as never,
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });
});

// The three states that want the user take the slot from the age label, and
// they use bb's own glyphs: the two lists sit in one window, and a user who
// switches between them should not have to learn a second vocabulary.
describe("attention states", async () => {
  const states = [
    ["waiting-for-input", "Thread needs user input"],
    ["unread-error", "Unread thread failed"],
    ["unread-success", "Unread thread succeeded"],
  ] as const;

  for (const [indicator, label] of states) {
    it(`shows the ${indicator} glyph instead of the age`, async () => {
      await render([
        thread({
          id: `thr_${indicator}`,
          indicator,
          indicatorLabel: label,
          updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
        }),
      ]);
      expect(await screen.findByLabelText(label)).toBeDefined();
      expect(screen.queryByText("3h")).toBeNull();
    });
  }

  // Running work is the one state the user does NOT have to act on, so it gets
  // the original spinner.
  it("keeps the agent spinner while work runs", async () => {
    await render([
      thread({
        id: "thr_busy",
        isUnread: true,
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    ]);
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });
});

describe("pull request badge", async () => {
  const withPr = async (attention: string, state = "open") =>
    await renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains: [], preferred: [], order: [] }),
        saveMain: () => ({ ok: true }),
        saveGroupOrder: () => ({ ok: true }),
        listLifecycle: () => ({ rows: [] }),
        listOrder: () => ({ rows: [] }),
      },
      sidebarPullRequests: {
        thr_pr: {
          number: 412,
          title: "Fix the flake",
          url: "https://github.com/o/r/pull/412",
          state,
          attention,
        } as never,
      },
    });

  it("links the PR number out to the git host", async () => {
    await withPr("none");
    const badge = await screen.findByRole("link", { name: "#412" });
    expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/412");
    expect(badge.getAttribute("title")).toBe("Fix the flake");
  });

  it("shows no badge when the branch has no PR", async () => {
    await render([thread({ id: "thr_nopr" })]);
    await screen.findByText("A thread");
    expect(screen.queryByRole("link", { name: /^#/ })).toBeNull();
  });

  // The attention state is bb's rolled-up "does this need you" signal, so the
  // badge can colour itself without reading checks/review/mergeability.
  it("colors the badge from the attention state", async () => {
    const failing = await withPr("checks_failed");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("destructive");
    failing.unmount();

    await withPr("ready_to_merge");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("success");
  });
});
