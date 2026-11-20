// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { fixture, project } from "./test-fixtures";

const app = await loadPluginApp(() => import("../app"));
const slot = app.threadLists[0]!;
const threeHoursAgo = Date.now() - (3 * 3_600_000 + 60_000);

interface PullRequestRow {
  number: number;
  title: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  attention: string;
}

function mountCard(
  threads: PluginSidebarThread[],
  pullRequest: PullRequestRow | null = null,
) {
  return renderSlot(
    slot,
    {
      activeThreadId: "elsewhere",
      activeProjectId: "project",
      isCompactViewport: false,
      onNavigate: () => {},
      searchQuery: "",
    },
    {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [project("project", "Treelanes")],
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
        listTitles: () => ({ rows: [] }),
        pullRequests: () => ({
          env: pullRequest
            ? { outcome: "available", pullRequest }
            : { outcome: "absent" },
        }),
      },
    },
  );
}

async function findCard(title = "main") {
  const link = await screen.findByRole("link", { name: title });
  const item = link.closest("li")!;
  const line = (name: "project" | "title" | "meta") =>
    item.querySelector<HTMLElement>(`[data-card-line="${name}"]`);
  const status = item.querySelector<HTMLElement>("[data-card-status]")!;
  return { item, line, status };
}

const follows = (earlier: Element, later: Element) =>
  Boolean(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

afterEach(cleanup);

describe("Worktree Card layout", () => {
  it("puts the project on line 1, the title on line 2, and the agent, branch, PR and threads control on line 3", async () => {
    mountCard(
      [
        fixture("main", "env", {
          providerId: "claude-code",
          title: "A long Worktree Card title",
          displayTitle: "A long Worktree Card title",
          updatedAt: threeHoursAgo,
        }),
        fixture("child", "env", {
          parentThreadId: "main",
          updatedAt: threeHoursAgo,
        }),
      ],
      {
        number: 566,
        title: "Ship the cards",
        url: "https://github.com/o/r/pull/566",
        state: "open",
        attention: "none",
      },
    );
    const { line } = await findCard("A long Worktree Card title");
    const projectLine = line("project")!;
    const titleLine = line("title")!;
    const metaLine = line("meta")!;
    expect(follows(projectLine, titleLine)).toBe(true);
    expect(follows(titleLine, metaLine)).toBe(true);

    const chip = projectLine.querySelector("[data-project-chip]")!;
    const projectName = within(projectLine).getByText("Treelanes");
    const status = projectLine.querySelector("[data-card-status]")!;
    expect(chip.textContent).toBe("TS");
    expect(follows(chip, projectName)).toBe(true);
    expect(follows(projectName, status)).toBe(true);
    expect(projectName.className).toContain("truncate");
    expect(projectName.className).toContain("text-xs");
    expect(projectName.className).toContain("text-muted-foreground");
    expect(projectLine.className).toContain("h-5");

    const title = within(titleLine).getByText("A long Worktree Card title");
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("text-sm");
    expect(title.className).toContain("font-medium");
    expect(title.className).not.toContain("line-clamp");
    expect(titleLine.className).toContain("mt-1");

    const glyph = within(metaLine).getByRole("img", { name: "Claude Code" });
    const branch = within(metaLine).getByTitle("same-branch");
    const badge = await within(metaLine).findByRole("link", {
      name: "PR #566 - Open: Ship the cards",
    });
    const toggle = within(metaLine).getByRole("button", {
      name: "Expand A long Worktree Card title",
    });
    expect(metaLine.firstElementChild!.contains(glyph)).toBe(true);
    expect(follows(glyph, branch)).toBe(true);
    expect(follows(branch, badge)).toBe(true);
    expect(follows(badge, toggle)).toBe(true);
    expect(toggle.textContent).toContain("2 threads");
    expect(glyph.getAttribute("class")).toContain("size-3");
    expect(glyph.getAttribute("class")).toContain("text-muted-foreground/70");
    expect(metaLine.className).toContain("mt-0.5");
    expect(metaLine.className).toContain("text-xs");
    expect(metaLine.className).toContain("text-muted-foreground");
    expect(
      Array.from(metaLine.querySelectorAll("[data-icon]")).map((icon) =>
        icon.getAttribute("data-icon"),
      ),
    ).toEqual(["GitPullRequestArrow", "ChevronDown"]);
  });

  it("makes an unread Main Thread's title semibold", async () => {
    mountCard([fixture("main", "env", { isUnread: true })]);
    const { line } = await findCard();
    expect(within(line("title")!).getByText("main").className).toContain(
      "font-semibold",
    );
  });

  it("shows the machine on line 3 when the thread has no branch", async () => {
    mountCard([
      fixture("main", null, { host: { id: "host_1", name: "Sawyer's MacBook" } }),
    ]);
    const { line } = await findCard();
    expect(within(line("meta")!).getByTitle("Sawyer's MacBook")).toBeDefined();
  });

  it("gives a card t3code's 78 px height", async () => {
    mountCard([fixture("main", "env")]);
    const { item, line } = await findCard();
    const body = item.querySelector("[data-card-body]")!;
    expect(body.className.split(" ")).toEqual(
      expect.arrayContaining(["h-[4.875rem]", "px-2.5", "py-2"]),
    );
    expect(body.className.split(" ")).not.toContain("h-auto");
    expect(line("meta")).not.toBeNull();
  });

  it("drops line 3 and moves the agent glyph up to the title when there is no branch, machine or PR", async () => {
    mountCard([fixture("main", null, { providerId: "claude-code" })]);
    const { item, line } = await findCard();
    const body = item.querySelector("[data-card-body]")!;
    expect(body.className.split(" ")).toContain("h-auto");
    expect(line("meta")).toBeNull();
    const glyph = within(line("title")!).getByRole("img", {
      name: "Claude Code",
    });
    expect(follows(within(line("title")!).getByText("main"), glyph)).toBe(true);
  });
});

describe("Worktree Card status slot", () => {
  it("shows the relative time when no thread has live work or needs attention", async () => {
    mountCard([fixture("main", "env", { updatedAt: threeHoursAgo })]);
    const { status } = await findCard();
    expect(status.textContent).toBe("3h");
    expect(status.querySelector("[data-status]")).toBeNull();
  });

  const running = { indicator: "runtime" as const };
  const needsInput = { hasPendingInteraction: true };
  const failed = { indicator: "unread-error" as const };
  const unread = { isUnread: true };
  const cases = [
    {
      name: "puts Input first, before Failed, Working and Done",
      children: [needsInput, failed, running, unread],
      kind: "input",
      label: "Input",
      icon: "MessageQuestion",
      color: "text-indigo-600",
      darkColor: "dark:text-indigo-300",
    },
    {
      name: "puts Failed before Working and Done",
      children: [failed, running, unread],
      kind: "failed",
      label: "Failed",
      icon: "AlertCircle",
      color: "text-red-700",
      darkColor: "dark:text-red-400",
    },
    {
      name: "puts Working before Done",
      children: [running, unread],
      kind: "running",
      label: "Working",
      icon: "treelanes/status-working",
      color: "text-blue-700",
      darkColor: "dark:text-blue-400",
    },
    {
      name: "shows Done last",
      children: [unread],
      kind: "unread",
      label: "Done",
      icon: "CircleCheck",
      color: "text-success-foreground",
      darkColor: "text-success-foreground",
    },
  ];
  for (const { name, children, kind, label, icon, color, darkColor } of cases) {
    it(name, async () => {
      mountCard([
        fixture("main", "env", { updatedAt: threeHoursAgo }),
        ...children.map((overrides, index) =>
          fixture(`child-${index}`, "env", {
            parentThreadId: "main",
            updatedAt: threeHoursAgo,
            ...overrides,
          }),
        ),
      ]);
      const { status } = await findCard();
      const shown = status.querySelector<HTMLElement>("[data-status]")!;
      expect(shown.getAttribute("data-status")).toBe(kind);
      expect(shown.textContent).toBe(label);
      expect(shown.className).toContain(color);
      expect(shown.className).toContain(darkColor);
      expect(shown.className).toContain("font-medium");
      expect(shown.querySelector("[data-icon]")!.getAttribute("data-icon")).toBe(
        icon,
      );
      expect(
        shown.querySelector("[data-icon]")!.getAttribute("class"),
      ).toContain("size-4");
      expect(status.textContent).not.toContain("3h");
    });
  }

  it("counts the threads when more than one share the top status, and keeps the summary words for screen readers", async () => {
    mountCard([
      fixture("main", "env", running),
      fixture("child", "env", { parentThreadId: "main", ...running }),
    ]);
    const { status } = await findCard();
    expect(status.querySelector("[data-status]")!.textContent).toBe("2 working");
    expect(
      status.closest("li")!.querySelector("[aria-live='polite']")!.textContent,
    ).toBe("2 running");
  });

  it("uses the Main Thread's own state on a card without a group", async () => {
    mountCard([fixture("main", null, { indicator: "waiting-for-input" })]);
    const { status } = await findCard();
    expect(status.querySelector("[data-status]")!.textContent).toBe("Input");
  });

  it("keeps every summary item in a live region for screen readers", async () => {
    mountCard([
      fixture("main", "env", running),
      fixture("child", "env", { parentThreadId: "main", ...unread }),
    ]);
    const { item } = await findCard();
    const live = item.querySelector("[aria-live='polite']")!;
    expect(live.className).toContain("sr-only");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.textContent).toContain("1 running");
    expect(live.textContent).toContain("1 unread");
  });

  it("hides the status and shows the row menu in its place on hover or focus", async () => {
    mountCard([fixture("main", "env", { updatedAt: threeHoursAgo })]);
    const { status } = await findCard();
    const shown = within(status).getByText("3h").closest("[data-status-value]")!;
    expect(shown.getAttribute("class")!.split(" ")).toEqual(
      expect.arrayContaining([
        "group-hover/card:opacity-0",
        "group-focus-within/card:opacity-0",
      ]),
    );
    const menu = status.querySelector("[data-card-menu]")!;
    expect(within(menu as HTMLElement).getByRole("button", { name: /actions/i })).toBeDefined();
    expect(menu.getAttribute("class")!.split(" ")).toEqual(
      expect.arrayContaining([
        "opacity-0",
        "group-hover/card:opacity-100",
        "group-focus-within/card:opacity-100",
      ]),
    );
  });
});

describe("Worktree Card pull request badge", () => {
  const pr = (state: PullRequestRow["state"]): PullRequestRow => ({
    number: 412,
    title: "Fix the flake",
    url: "https://github.com/o/r/pull/412",
    state,
    attention: "none",
  });
  const cases = [
    ["open", "Open", "GitPullRequestArrow", "text-emerald-600"],
    ["draft", "Draft", "GitPullRequestDraft", "text-zinc-500"],
    ["closed", "Closed", "GitPullRequestClosed", "text-red-600"],
    ["merged", "Merged", "GitMerge", "text-violet-600"],
  ] as const;
  for (const [state, label, icon, color] of cases) {
    it(`draws a ${state} PR with t3code's icon and color`, async () => {
      mountCard([fixture("main", "env")], pr(state));
      const badge = await screen.findByRole("link", {
        name: `PR #412 - ${label}: Fix the flake`,
      });
      expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/412");
      expect(badge.textContent).toBe("412");
      const glyph = badge.querySelector("[data-icon]")!;
      expect(glyph.getAttribute("data-icon")).toBe(icon);
      expect(glyph.getAttribute("class")).toContain(color);
      expect(glyph.getAttribute("class")).toContain("size-3");
    });
  }
});
