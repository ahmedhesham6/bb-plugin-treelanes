import { describe, expect, it, vi } from "vitest";
import {
  captureWorkspace,
  completionEvidenceSchema,
  taskContextSchema,
} from "./stage-evidence";

import { makeWorkspaceSdk as makeSdk } from "./test-workspace";

type FileSideQuery = { target: string; mergeBaseRef: string; path: string; side: "old" | "new" };
type FileSideInput = { environmentId: string; query: FileSideQuery };

/** The file sides a capture read from the bb--git plugin. */
function fileSides(fixture: ReturnType<typeof makeSdk>): FileSideQuery[] {
  return fixture.calls
    .filter(({ area }) => area === "git.fileSide")
    .map(({ args }) => (args as FileSideInput).query);
}

describe("stage evidence schemas", () => {
  it("accepts bounded task context and a versioned completion receipt", () => {
    expect(
      taskContextSchema.parse({
        outcome: "Implement the change",
        scope: ["stage-evidence.ts"],
        decisions: ["Use the public SDK"],
        requiredChecks: ["npm test"],
        allowedActions: ["Edit implementation files"],
      }),
    ).toMatchObject({ outcome: "Implement the change" });

    expect(
      completionEvidenceSchema.parse({
        stage: "quality",
        taskRevision: 2,
        stageUpdatedAt: 1_700_000_000_000,
        workspaceDigest: "digest",
        checks: [{ name: "tests", status: "passed", evidence: "42 passed" }],
        decisionsResolved: true,
        openFindings: [],
        summary: "All checks pass.",
      }),
    ).toMatchObject({ stage: "quality", taskRevision: 2 });

    expect(
      completionEvidenceSchema.parse({
        stage: "design",
        stageUpdatedAt: 1,
        workspaceDigest: "digest",
        checks: [],
        decisionsResolved: true,
        openFindings: [],
        summary: "Legacy receipt.",
      }),
    ).toMatchObject({ taskRevision: 0 });
  });

  it("rejects unknown fields and oversized receipt fields", () => {
    expect(
      taskContextSchema.safeParse({
        outcome: "ok",
        scope: [],
        decisions: [],
        requiredChecks: [],
        allowedActions: [],
        extra: true,
      }).success,
    ).toBe(false);

    expect(
      completionEvidenceSchema.safeParse({
        stage: "design",
        stageUpdatedAt: 1,
        workspaceDigest: "digest",
        checks: [],
        decisionsResolved: true,
        openFindings: [],
        summary: "x".repeat(5000),
      }).success,
    ).toBe(false);
  });
});

describe("captureWorkspace", () => {
  it("changes the digest for same-size tracked content changes", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    const first = await captureWorkspace(fixture.sdk, "environment-one");
    fixture.files.set("src/file.ts", { content: "neu" });
    const second = await captureWorkspace(fixture.sdk, "environment-one");

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
  });

  it("includes untracked file content in the digest", async () => {
    const fixture = makeSdk({
      files: { "notes.md": { content: "one" } },
      diffFiles: [
        {
          path: "notes.md",
          previousPath: null,
          changeKind: "added",
          additions: 1,
          deletions: 0,
          binary: false,
          origin: "untracked",
        },
      ],
      diffFilesByTarget: {
        all: [
          {
            path: "notes.md",
            previousPath: null,
            changeKind: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            origin: "untracked",
          },
        ],
        branch_committed: [],
        uncommitted: [
          {
            path: "notes.md",
            previousPath: null,
            changeKind: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            origin: "untracked",
          },
        ],
      },
    });
    const first = await captureWorkspace(fixture.sdk, "environment-one");
    fixture.files.set("notes.md", { content: "two" });
    const second = await captureWorkspace(fixture.sdk, "environment-one");

    expect(second).not.toBe(first);
    expect(fixture.calls.some(({ area }) => area === "files.read")).toBe(true);
    expect(
      fileSides(fixture).some(
        (query) => query.target === "all" && query.side === "old",
      ),
    ).toBe(false);
  });

  it("does not request a base blob for an added file", async () => {
    const fixture = makeSdk({
      files: { "new.txt": { content: "new" } },
      diffFilesByTarget: {
        all: [
          {
            path: "new.txt",
            previousPath: null,
            changeKind: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            origin: "tracked",
          },
        ],
        branch_committed: [],
        uncommitted: [
          {
            path: "new.txt",
            previousPath: null,
            changeKind: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            origin: "tracked",
          },
        ],
      },
    });

    await captureWorkspace(fixture.sdk, "environment-one");

    expect(
      fileSides(fixture).some(
        (query) =>
          (query.target === "all" && query.side === "old") ||
          (query.target === "branch_committed" && query.side === "new"),
      ),
    ).toBe(false);
  });

  it("does not request a worktree blob for a deleted file", async () => {
    const fixture = makeSdk({
      files: {},
      diffFilesByTarget: {
        all: [
          {
            path: "removed.txt",
            previousPath: null,
            changeKind: "deleted",
            additions: 0,
            deletions: 1,
            binary: false,
            origin: "tracked",
          },
        ],
        branch_committed: [],
        uncommitted: [
          {
            path: "removed.txt",
            previousPath: null,
            changeKind: "deleted",
            additions: 0,
            deletions: 1,
            binary: false,
            origin: "tracked",
          },
        ],
      },
    });

    await captureWorkspace(fixture.sdk, "environment-one");

    expect(
      fixture.calls.some(({ area }) => area === "files.read"),
    ).toBe(false);
    expect(
      fileSides(fixture).some(
        (query) =>
          query.target === "all" &&
          query.path === "removed.txt" &&
          query.side === "old",
      ),
    ).toBe(true);
  });

  it("uses both sides of a rename without asking for missing blobs", async () => {
    const fixture = makeSdk({
      files: { "renamed.txt": { content: "new" } },
      diffFilesByTarget: {
        all: [
          {
            path: "renamed.txt",
            previousPath: "original.txt",
            changeKind: "renamed",
            additions: 0,
            deletions: 0,
            binary: false,
            origin: "tracked",
          },
        ],
        branch_committed: [
          {
            path: "renamed.txt",
            previousPath: "original.txt",
            changeKind: "renamed",
            additions: 0,
            deletions: 0,
            binary: false,
            origin: "tracked",
          },
        ],
        uncommitted: [],
      },
    });

    await captureWorkspace(fixture.sdk, "environment-one");

    expect(fixture.calls).toContainEqual({
      area: "git.fileSide",
      args: {
        environmentId: "environment-one",
        query: {
          target: "all",
          mergeBaseRef: "base-1",
          path: "original.txt",
          side: "old",
        },
      },
    });
    expect(fixture.calls).toContainEqual({
      area: "git.fileSide",
      args: {
        environmentId: "environment-one",
        query: {
          target: "branch_committed",
          mergeBaseRef: "base-1",
          path: "renamed.txt",
          side: "new",
        },
      },
    });
    expect(
      fileSides(fixture).some(
        (query) =>
          query.target === "all" &&
          query.path === "renamed.txt" &&
          query.side === "old",
      ),
    ).toBe(false);
    expect(fixture.calls).toContainEqual({
      area: "files.read",
      args: {
        hostId: "remote-host",
        path: "/srv/worktree/renamed.txt",
        rootPath: "/srv/worktree",
      },
    });
  });

  it("fails when the dirty diff side disagrees with the host file read", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    const originalFileSide = fixture.git.fileSide;
    fixture.git.fileSide = async (input) => {
      const { query } = input as FileSideInput;
      if (
        query.path === "src/file.ts" &&
        query.target === "all" &&
        query.side === "new"
      ) {
        return {
          outcome: "available",
          file: { path: query.path, content: "stale", contentEncoding: "utf8", sizeBytes: 5 },
        };
      }
      return originalFileSide(input);
    };

    await expect(
      captureWorkspace(fixture.sdk, "environment-one"),
    ).rejects.toThrow(/changed while it was captured/u);
  });

  it("does not hide a missing base read error for a present base path", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    const originalFileSide = fixture.git.fileSide;
    // The Git plugin reports a file side that it cannot read as an outcome.
    fixture.git.fileSide = async (input) => {
      const { query } = input as FileSideInput;
      if (query.target === "all" && query.side === "old") {
        return { outcome: "unavailable", code: "ENOENT", message: "base blob unavailable" };
      }
      return originalFileSide(input);
    };

    await expect(
      captureWorkspace(fixture.sdk, "environment-one"),
    ).rejects.toThrow(/Workspace snapshot unavailable while reading base file src\/file\.ts: base blob unavailable/u);
  });

  it("reports a disabled Git plugin as an unavailable workspace snapshot", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    fixture.sdk.plugins.callRpc = async () => {
      throw new Error("Plugin bb--git is disabled");
    };

    await expect(
      captureWorkspace(fixture.sdk, "environment-one"),
    ).rejects.toThrow(/Workspace snapshot unavailable while reading workspace status: Plugin bb--git is disabled/u);
  });

  it("rejects a truncated changed-file response", async () => {
    const fixture = makeSdk({
      files: { "src/file.ts": { content: "new" } },
      truncated: true,
    });

    await expect(
      captureWorkspace(fixture.sdk, "environment-one"),
    ).rejects.toThrow(/truncated|incomplete/u);
  });

  it("routes current file reads to the environment host and root", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    await captureWorkspace(fixture.sdk, "environment-one");

    expect(fixture.calls).toContainEqual({
      area: "files.read",
      args: {
        hostId: "remote-host",
        path: "/srv/worktree/src/file.ts",
        rootPath: "/srv/worktree",
      },
    });
    expect(fixture.calls).toContainEqual({
      area: "git.fileSide",
      args: {
        environmentId: "environment-one",
        query: {
          target: "all",
          mergeBaseRef: "base-1",
          path: "src/file.ts",
          side: "old",
        },
      },
    });
  });

  it("rejects unavailable status and diff responses", async () => {
    const statusFixture = makeSdk({
      files: { "src/file.ts": { content: "new" } },
      statusOutcome: "unavailable",
    });
    await expect(
      captureWorkspace(statusFixture.sdk, "environment-one"),
    ).rejects.toThrow(/unavailable/u);

    const diffFixture = makeSdk({
      files: { "src/file.ts": { content: "new" } },
      diffOutcome: "unavailable",
    });
    await expect(
      captureWorkspace(diffFixture.sdk, "environment-one"),
    ).rejects.toThrow(/unavailable/u);
  });
  it("reads workspace status, diffs, changed files and file sides through the bb--git plugin", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    // The fake has no retired environment reads, so only the bb--git RPC can serve them.
    expect(Object.keys(fixture.sdk.environments)).toEqual(["get"]);
    const rpcs: Array<{ pluginId: string; method: string; input: unknown }> = [];
    const sdk = {
      ...fixture.sdk,
      plugins: {
        callRpc: async (args: Parameters<typeof fixture.sdk.plugins.callRpc>[0]) => {
          rpcs.push({ pluginId: args.pluginId, method: args.method, input: args.input });
          return fixture.sdk.plugins.callRpc(args);
        },
      },
    } as unknown as typeof fixture.sdk;

    expect(await captureWorkspace(sdk, "environment-one")).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(rpcs.map(({ pluginId }) => pluginId))).toEqual(new Set(["bb--git"]));
    const environmentId = "environment-one";
    const committed = { type: "branch_committed", mergeBaseBranch: "main" };
    const all = { type: "all", mergeBaseBranch: "main" };
    expect(rpcs.map(({ method, input }) => ({ method, input }))).toEqual(expect.arrayContaining([
      { method: "workspaceStatus", input: { environmentId, mergeBaseBranch: "main" } },
      { method: "diff", input: { environmentId, target: committed } },
      { method: "diff", input: { environmentId, target: { type: "uncommitted" } } },
      { method: "diff", input: { environmentId, target: all } },
      { method: "files", input: { environmentId, target: all, ignoreWhitespace: false } },
      { method: "files", input: { environmentId, target: committed, ignoreWhitespace: false } },
      { method: "fileSide", input: { environmentId, query: { target: "all", mergeBaseRef: "base-1", path: "src/file.ts", side: "old" } } },
    ]));
  });

  it("reads 100 changed files within a few host round trips", async () => {
    const paths = Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`);
    const fixture = makeSdk({
      files: Object.fromEntries(paths.map((path) => [path, { content: `new ${path}` }])),
      diffFiles: paths.map((path) => ({ path, previousPath: null, changeKind: "modified" as const,
        additions: 1, deletions: 1, binary: false, origin: "tracked" as const, loadMode: "auto" as const })),
    });
    const slow = (read: (args: Record<string, unknown>) => Promise<unknown>) => async (args: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return read(args);
    };
    const sdk = fixture.sdk as unknown as {
      files: { read: (args: Record<string, unknown>) => Promise<unknown> };
    };
    fixture.git.fileSide = slow(fixture.git.fileSide);
    sdk.files.read = slow(sdk.files.read);

    vi.useFakeTimers();
    let finished = false;
    const capture = captureWorkspace(fixture.sdk, "environment-one").then(() => { finished = true; });
    try {
      // Advance host latency without making this check depend on machine load.
      await vi.advanceTimersByTimeAsync(600);
      expect(finished).toBe(true);
    } finally {
      await vi.runAllTimersAsync();
      await capture;
      vi.useRealTimers();
    }
  });
});
