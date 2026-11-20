// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { fixture, project } from "./test-fixtures";
const app = await loadPluginApp(() => import("../app"));
const slot = app.threadLists[0]!;
const props = {
  activeThreadId: "a",
  activeProjectId: "project",
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
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
        projects: [project("project", "Project")],
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
  expect(view.navigateCalls).toEqual([]);
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
  expect(view.navigateCalls).toEqual([
    { method: "toThread", threadId: "a-child", options: { split: false } },
    { method: "toThread", threadId: "b", options: { split: false } },
  ]);
});
it("lets the chevron inspect one group without opening a thread", async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Expand b" }));
  expect(screen.queryByRole("link", { name: "a-child" })).toBeNull();
  expect(screen.getByRole("link", { name: "b-child" })).toBeDefined();
  expect(view.navigateCalls).toHaveLength(0);
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
  expect(
    screen.queryByRole("menuitem", { name: "Use as main thread" }),
  ).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await open("b-root");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use as main thread" }),
  );
  await waitFor(() =>
    expect(view.rpcCalls).toContainEqual({
      method: "saveMain",
      input: expect.objectContaining({
        environmentId: "two",
        threadId: "b-root",
      }),
    }),
  );
  expect(view.navigateCalls).toHaveLength(0);
});
it("repairs a saved child main to its root once", async () => {
  const info = vi.spyOn(toast, "info");
  const view = mount("b", [], "b-child");
  await waitFor(() =>
    expect(view.rpcCalls.filter((c) => c.method === "listGroups")).toHaveLength(
      2,
    ),
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
  expect(info.mock.calls).toEqual([["Main thread changed to b."]]);
  info.mockRestore();
});
it("shows an alert and no thread list when lifecycle data cannot load", async () => {
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
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load Treelanes.",
  );
  expect(screen.queryByText("No threads yet")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
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
  expect(await screen.findByRole("alert")).toBeDefined();
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
      originPluginId: "treelanes",
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
        projects: [project("project", "Project")],
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
        // One row for the worktree: its Main Thread and Child Row share it.
        pullRequests: () => ({
          env: {
            outcome: "available",
            pullRequest: {
              number: 123,
              title: "Invoice payments",
              url: "https://github.com/example/repo/pull/123",
              state: "open",
              attention: "none",
            },
          },
        }),
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
  const badges = await screen.findAllByRole("link", { name: "#123" });
  expect(badges.map((badge) => badge.getAttribute("href"))).toEqual([
    "https://github.com/example/repo/pull/123",
    "https://github.com/example/repo/pull/123",
  ]);
  expect(
    badges.some((badge) =>
      badge.closest("li")?.textContent?.includes("Test invoice payments"),
    ),
  ).toBe(true);
  expect(source[1].title).toBe("Workflow TDD [env_abc:tdd:1]");
});

function mountWorktree(
  source: ReturnType<typeof fixture>[],
  titles: { threadId: string; original: string; generated: string }[] = [],
  activeThreadId = "main",
) {
  return renderSlot(
    slot,
    { ...props, activeThreadId },
    {
      sidebarThreads: {
        status: "ready",
        threads: source,
        projects: [project("project", "Project")],
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
        listTitles: () => ({ rows: titles }),
      },
    },
  );
}
const follows = (earlier: Element, later: Element) =>
  Boolean(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

it("shows a board worker's Setup Step title without offering Regenerate title", async () => {
  const runName = "Workflow TDD [env_58xxv6nf3t:tdd:1795162300141]";
  const view = mountWorktree(
    [
      fixture("main", "env"),
      fixture("worker", "env", {
        parentThreadId: "main",
        title: runName,
        originPluginId: "treelanes",
      }),
    ],
    [{ threadId: "worker", original: runName, generated: "Write the failing tests" }],
  );
  expect(
    await screen.findByRole("link", { name: "Write the failing tests" }),
  ).toBeDefined();
  expect(screen.queryByText(runName)).toBeNull();
  expect(view.rpcCalls.filter((call) => call.method === "listTitles")).toEqual([
    { method: "listTitles", input: { threadIds: ["worker"] } },
  ]);
  fireEvent.contextMenu(await screen.findByText("Write the failing tests"));
  const menu = await screen.findByRole("menu", { name: "Thread actions" });
  expect(within(menu).getByText("Pin")).toBeDefined();
  expect(within(menu).queryByText("Regenerate title")).toBeNull();
});

it("shows a human rename of a board worker instead of its Setup Step title", async () => {
  mountWorktree(
    [
      fixture("main", "env"),
      fixture("worker", "env", {
        parentThreadId: "main",
        title: "My own name",
        originPluginId: "treelanes",
      }),
    ],
    [
      {
        threadId: "worker",
        original: "Workflow TDD [env_58xxv6nf3t:tdd:1795162300141]",
        generated: "Write the failing tests",
      },
    ],
  );
  expect(await screen.findByRole("link", { name: "My own name" })).toBeDefined();
  expect(screen.queryByText("Write the failing tests")).toBeNull();
});

it("lays out a Child Row on one line: title, time, then the agent glyph", async () => {
  mountWorktree([
    fixture("main", "env"),
    fixture("child", "env", {
      parentThreadId: "main",
      title: "A long child thread title",
      providerId: "claude-code",
      updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
    }),
  ]);
  const link = await screen.findByRole("link", {
    name: "A long child thread title",
  });
  const item = link.closest("li")!;
  const title = within(item).getByText("A long child thread title");
  const time = within(item).getByText("3h");
  const glyph = within(item).getByRole("img", { name: "Claude Code" });
  expect(title.className).toContain("truncate");
  expect(title.className).not.toContain("line-clamp");
  expect(follows(title, time)).toBe(true);
  expect(follows(time, glyph)).toBe(true);
  expect(glyph.closest(".sr-only")).toBeNull();
  expect(glyph.getAttribute("class")).toContain("size-3.5");
  expect(glyph.getAttribute("class")).toContain("opacity-60");
  const line = title.parentElement!;
  expect(line.contains(time)).toBe(true);
  expect(line.contains(glyph)).toBe(true);
  const button = within(item).getByRole("button", {
    name: "Actions for A long child thread title",
  });
  expect(line.contains(button)).toBe(true);
  expect(button.closest("[hidden], [aria-hidden='true'], .invisible, .hidden")).toBeNull();
  button.focus();
  expect(document.activeElement).toBe(button);
});

it("puts the agent glyph at the far right of a Worktree Card's meta line", async () => {
  mountWorktree(
    [
      fixture("main", "env", { providerId: "claude-code" }),
      fixture("child", "env", { parentThreadId: "main", providerId: "codex" }),
    ],
    [],
    "elsewhere",
  );
  const link = await screen.findByRole("link", { name: "main" });
  const item = link.closest("li")!;
  const meta = within(item).getByText("same-branch");
  const toggle = within(item).getByRole("button", { name: "Expand main" });
  const glyph = within(item).getByRole("img", { name: "Claude Code" });
  expect(toggle.textContent).toContain("2 threads");
  expect(follows(meta, toggle)).toBe(true);
  expect(follows(toggle, glyph)).toBe(true);
  expect(meta.closest(".truncate")).not.toBeNull();
  expect(glyph.getAttribute("class")).toContain("size-3.5");
  expect(glyph.getAttribute("class")).toContain("opacity-60");
});

it("asks for the titles of every board worker in bounded batches", async () => {
  const workers = Array.from({ length: 501 }, (_, index) =>
    fixture(`worker-${String(index).padStart(3, "0")}`, "env", {
      parentThreadId: "main",
      title: `Workflow TDD [env_abc:tdd:${index}]`,
      originPluginId: "treelanes",
    }),
  );
  const view = mountWorktree(
    [fixture("main", "env"), fixture("own", "env", { parentThreadId: "main" }), ...workers],
    [],
    "elsewhere",
  );
  await waitFor(() =>
    expect(view.rpcCalls.filter((call) => call.method === "listTitles")).toHaveLength(2),
  );
  const batches = view.rpcCalls
    .filter((call) => call.method === "listTitles")
    .map((call) => (call.input as { threadIds: string[] }).threadIds);
  expect(batches.map((ids) => ids.length)).toEqual([500, 1]);
  expect(batches.flat().sort()).toEqual(workers.map((worker) => worker.id));
});

it("keeps a Child Row's menu button shown while its menu is open", async () => {
  mountWorktree([
    fixture("main", "env"),
    fixture("child", "env", {
      parentThreadId: "main",
      updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
    }),
  ]);
  const button = await screen.findByRole("button", { name: "Actions for child" });
  const time = screen.getByText("3h").parentElement!;
  expect(button.parentElement!.classList.contains("opacity-0")).toBe(true);
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
  await screen.findByRole("menuitem", { name: "Pin" });
  expect(button.parentElement!.classList.contains("opacity-100")).toBe(true);
  expect(button.parentElement!.classList.contains("opacity-0")).toBe(false);
  expect(time.classList.contains("opacity-0")).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() =>
    expect(button.parentElement!.classList.contains("opacity-0")).toBe(true),
  );
});
