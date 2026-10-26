// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixture } from "./test-fixtures";
const app = await loadPluginApp(() => import("../app"));
const slot = app.threadLists[0]!;
const props = {
  activeThreadId: "a",
  activeProjectId: "project",
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
  Original: () => <p>BB fallback</p>,
};
const threads = [
  fixture("a", "one"),
  fixture("a-child", "one", {
    parentThreadId: "a",
    hasPendingInteraction: true,
  }),
  fixture("b", "two"),
  fixture("b-child", "two", { parentThreadId: "b" }),
  fixture("b-root", "two", { createdAt: 2 }),
];
function mount(
  activeThreadId: string | null = "a",
  lifecycle: unknown[] = [],
  twoMain = "b",
) {
  const mains = [
    { projectId: "project", environmentId: "one", threadId: "a" },
    { projectId: "project", environmentId: "two", threadId: twoMain },
  ];
  return renderSlot(
    slot,
    { ...props, activeThreadId },
    {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "project", name: "Project", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({ mains, preferred: [], order: [] }),
        listOrder: () => ({ rows: [] }),
        listLifecycle: () => ({ rows: lifecycle }),
        settle: () => ({ ok: true }),
        saveMain: (input) => {
          const r = input as (typeof mains)[number];
          mains.find((m) => m.environmentId === r.environmentId)!.threadId =
            r.threadId;
          return { ok: true };
        },
      },
    },
  );
}
afterEach(cleanup);
it("settles all threads from the main menu and only one from a child menu", async () => {
  const view = mount("b");
  for (const [id, label, input] of [
    ["b", "Settle all threads", { threadId: "b", includeWorktree: true }],
    ["b-child", "Settle thread", { threadId: "b-child" }],
  ] as const) {
    fireEvent.pointerDown(await screen.findByRole("button", { name: `Actions for ${id}` }),
      { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(view.rpcCalls).toContainEqual({ method: "settle", input }));
  }
});
it("opens only the selected worktree and follows external child navigation", async () => {
  const view = mount();
  expect(await screen.findByRole("link", { name: "a-child" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "b-child" })).toBeNull();
  const Component = slot.component;
  view.rerender(<Component {...props} activeThreadId="b-child" />);
  expect(await screen.findByRole("link", { name: "b-child" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "a-child" })).toBeNull();
  expect(screen.getByText("1 needs input")).toBeDefined();
  expect(view.sidebarActionCalls).toEqual([]);
});
it("keeps the group open when selecting a child, and collapses after selecting another main", async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole("link", { name: "a-child" }));
  const Component = slot.component;
  view.rerender(<Component {...props} activeThreadId="a-child" />);
  expect(screen.getByRole("link", { name: "a-child" })).toBeDefined();
  fireEvent.click(screen.getByRole("link", { name: "b" }));
  view.rerender(<Component {...props} activeThreadId="b" />);
  expect(screen.queryByRole("link", { name: "a-child" })).toBeNull();
  expect(screen.getByRole("link", { name: "b-child" })).toBeDefined();
  expect(view.sidebarActionCalls.map((c) => c.method)).toEqual([
    "open",
    "open",
  ]);
});
it("lets the chevron inspect one group without opening a thread", async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Expand b" }));
  expect(screen.queryByRole("link", { name: "a-child" })).toBeNull();
  expect(screen.getByRole("link", { name: "b-child" })).toBeDefined();
  expect(view.sidebarActionCalls).toHaveLength(0);
});
it("reveals a selected settled child without restoring its lifecycle", async () => {
  const view = mount("b-child", [
    {
      threadId: "b-child",
      settledAt: 200,
      snoozedAt: null,
      snoozedUntil: null,
    },
  ]);
  expect(await screen.findByRole("link", { name: "b-child" })).toBeDefined();
  expect(view.rpcCalls.some((c) => c.method === "unsettle")).toBe(false);
});
it("offers a root but not a child as main thread, without changing thread parents", async () => {
  const view = mount("b");
  const open = async (id: string) =>
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: `Actions for ${id}` }),
      { button: 0, ctrlKey: false },
    );
  await open("b-child");
  await screen.findByRole("menuitem", { name: "Settle thread" });
  expect(screen.queryByRole("menuitem", { name: "Use as main thread" })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await open("b-root");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use as main thread" }),
  );
  await waitFor(() =>
    expect(view.rpcCalls).toContainEqual({
      method: "saveMain",
      input: expect.objectContaining({ environmentId: "two", threadId: "b-root" }),
    }),
  );
  expect(view.sidebarActionCalls).toHaveLength(0);
});
it("repairs a saved child main to its root once", async () => {
  const view = mount("b", [], "b-child");
  await waitFor(() =>
    expect(view.rpcCalls.filter((c) => c.method === "listGroups")).toHaveLength(2),
  );
  expect(view.rpcCalls.filter((c) => c.method === "saveMain")).toEqual([
    {
      method: "saveMain",
      input: {
        projectId: "project",
        environmentId: "two",
        threadId: "b",
        expectedThreadId: "b-child",
      },
    },
  ]);
});
it("falls back to BB when lifecycle data cannot load", async () => {
  renderSlot(slot, props, {
    sidebarThreads: { status: "ready", threads, projects: [] },
    rpc: {
      listGroups: () => ({ mains: [], preferred: [], order: [] }),
      listOrder: () => ({ rows: [] }),
      listLifecycle: () => {
        throw new Error("offline");
      },
    },
  });
  expect(await screen.findByText("BB fallback")).toBeDefined();
  expect(screen.queryByText("No threads yet")).toBeNull();
});

it("discards an old manual expansion when navigation returns to a main thread", async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Expand b" }));
  const Component = slot.component;
  view.rerender(<Component {...props} activeThreadId="b" />);
  view.rerender(<Component {...props} activeThreadId="a" />);
  expect(await screen.findByRole("link", { name: "a-child" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "b-child" })).toBeNull();
});
it("reloads lifecycle state when the connection returns", async () => {
  let online = false;
  const view = renderSlot(slot, props, {
    sidebarThreads: { status: "ready", threads, projects: [] },
    rpc: {
      listGroups: () => ({ mains: [], preferred: [], order: [] }),
      saveMain: () => ({ ok: true }),
      listOrder: () => ({ rows: [] }),
      listLifecycle: () => {
        if (!online) throw new Error("offline");
        return { rows: [] };
      },
    },
  });
  expect(await screen.findByText("BB fallback")).toBeDefined();
  online = true;
  await view.behavior.setRealtimeConnectionState("reconnecting");
  await view.behavior.setRealtimeConnectionState("connected");
  expect(await screen.findByRole("link", { name: "a-child" })).toBeDefined();
});

it("shows Luna titles, the agent spinner, a group running dot, and child PR links", async () => {
  const source = [
    fixture("main", "env"),
    fixture("child", "env", {
      parentThreadId: "main",
      title: "Workflow TDD [env_abc:tdd:1]",
      indicator: "runtime",
      indicatorLabel: "Agent running",
    }),
  ];
  renderSlot(
    slot,
    { ...props, activeThreadId: "main" },
    {
      sidebarThreads: {
        status: "ready",
        threads: source,
        projects: [{ id: "project", name: "Project", isPersonal: false }],
      },
      rpc: {
        listGroups: () => ({
          mains: [
            { projectId: "project", environmentId: "env", threadId: "main" },
          ],
          preferred: [],
          order: [],
        }),
        listOrder: () => ({ rows: [] }),
        listLifecycle: () => ({ rows: [] }),
        listTitles: () => ({
          rows: [
            {
              threadId: "child",
              original: source[1].title,
              generated: "Test invoice payments",
            },
          ],
        }),
      },
      sidebarPullRequests: {
        child: {
          number: 123,
          title: "Invoice payments",
          url: "https://github.com/example/repo/pull/123",
          state: "open",
          attention: "none",
        },
      },
    },
  );
  expect(
    await screen.findByRole("link", { name: "Test invoice payments" }),
  ).toBeDefined();
  expect(screen.getByLabelText("Agent running").getAttribute("data-icon")).toBe(
    "Loading",
  );
  const running = screen.getByText("1 running");
  expect(running.querySelector("[data-running-dot]")).not.toBeNull();
  expect(screen.getByRole("link", { name: "#123" }).getAttribute("href")).toBe(
    "https://github.com/example/repo/pull/123",
  );
  expect(source[1].title).toBe("Workflow TDD [env_abc:tdd:1]");
});
