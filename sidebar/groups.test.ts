import { describe, expect, it } from "vitest";
import { buildGroups, groupAttention, worktreeKey } from "./groups";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { fixture } from "./test-fixtures";
const empty = new Map();
describe("worktree grouping", () => {
  it("includes roots and deep descendants once, without crossing environments or projects", () => {
    const threads = [
      fixture("root"),
      fixture("child", "env", { parentThreadId: "root" }),
      fixture("deep", "env", { parentThreadId: "child" }),
      fixture("other", "second", { parentThreadId: "root" }),
      fixture("project2", "env", { projectId: "second" }),
      fixture("ordinary", null),
    ];
    const groups = buildGroups(threads, empty, empty, empty, () => "active");
    expect(groups.map((g) => g.members.length)).toEqual([3, 1, 1, 1]);
    expect(
      groups
        .flatMap((g) => g.members)
        .map((t) => t.id)
        .sort(),
    ).toEqual(threads.map((t) => t.id).sort());
    expect(threads[1]?.parentThreadId).toBe("root");
  });
  it("keeps a saved main despite a newer board choice, and replaces an archived main", () => {
    const a = fixture("a"),
      b = fixture("b", "env", { createdAt: 2 });
    const key = worktreeKey(a)!;
    expect(
      buildGroups(
        [a, b],
        new Map([[key, "b"]]),
        new Map([[key, "a"]]),
        empty,
        () => "active",
      )[0]?.main.id,
    ).toBe("b");
    expect(
      buildGroups(
        [{ ...b, isArchived: true }, a],
        new Map([[key, "b"]]),
        empty,
        empty,
        () => "active",
      )[0]?.main.id,
    ).toBe("a");
  });
  it("uses the board initiator before roots and handles cycles and missing parents", () => {
    const a = fixture("a", "env", { parentThreadId: "b" }),
      b = fixture("b", "env", { parentThreadId: "a" });
    expect(
      buildGroups([b, a], empty, empty, empty, () => "active")[0]?.main.id,
    ).toBe("a");
    expect(
      buildGroups(
        [a, b],
        empty,
        new Map([[worktreeKey(a)!, "b"]]),
        empty,
        () => "active",
      )[0]?.main.id,
    ).toBe("b");
    expect(
      buildGroups(
        [a, b, fixture("c", "env", { parentThreadId: "a" })],
        empty,
        new Map([[worktreeKey(a)!, "c"]]),
        empty,
        () => "active",
      )[0]?.main.id,
    ).toBe("c");
  });
  it("resolves a saved or board child main to its root in the group", () => {
    const root = fixture("root"),
      child = fixture("child", "env", { parentThreadId: "root", createdAt: 2 }),
      deep = fixture("deep", "env", { parentThreadId: "child", createdAt: 3 });
    const key = worktreeKey(root)!;
    const main = (mains: Map<string, string>, preferred: Map<string, string>) =>
      buildGroups(
        [root, child, deep],
        mains,
        preferred,
        empty,
        () => "active",
      )[0]?.main.id;
    expect(main(new Map([[key, "deep"]]), empty)).toBe("root");
    const self = fixture("self", "env", { parentThreadId: "self" });
    expect(
      buildGroups(
        [self],
        new Map([[key, "self"]]),
        empty,
        empty,
        () => "active",
      )[0]?.main.id,
    ).toBe("self");
    expect(main(empty, new Map([[key, "child"]]))).toBe("root");
  });
  it("keeps a settled root as main in an active group and raises pinned children", () => {
    const groups = buildGroups(
      [
        fixture("main"),
        fixture("child", "env", { parentThreadId: "main", isPinned: true }),
      ],
      new Map([[worktreeKey(fixture("main"))!, "child"]]),
      empty,
      empty,
      (t) => (t.id === "main" ? "settled" : "active"),
    );
    expect(groups[0]).toMatchObject({
      shelf: "active",
      pinned: true,
      main: { id: "main" },
    });
  });
  it("reports hidden child attention together with running work", () => {
    expect(
      groupAttention([
        fixture("a", "env", { hasPendingInteraction: true }),
        fixture("b", "env", { indicator: "runtime" }),
        fixture("c", "env", { indicator: "unread-error", isUnread: true }),
      ]),
    ).toBe("1 needs input · 1 failed · 1 running · 1 unread");
  });
});
