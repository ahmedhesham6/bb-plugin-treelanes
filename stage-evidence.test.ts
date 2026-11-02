import { describe, expect, it } from "vitest";
import {
  captureWorkspace,
  completionEvidenceSchema,
  taskContextSchema,
} from "./stage-evidence";

import { makeWorkspaceSdk as makeSdk } from "./test-workspace";

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
      fixture.calls.some(
        ({ area, args }) =>
          area === "environments.diffFile" &&
          args.target === "all" &&
          args.side === "old",
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
      fixture.calls.some(
        ({ area, args }) =>
          area === "environments.diffFile" &&
          ((args.target === "all" && args.side === "old") ||
            (args.target === "branch_committed" && args.side === "new")),
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
      fixture.calls.some(
        ({ area, args }) =>
          area === "environments.diffFile" &&
          args.target === "all" &&
          args.path === "removed.txt" &&
          args.side === "old",
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
      area: "environments.diffFile",
      args: {
        environmentId: "environment-one",
        target: "all",
        mergeBaseRef: "base-1",
        path: "original.txt",
        side: "old",
      },
    });
    expect(fixture.calls).toContainEqual({
      area: "environments.diffFile",
      args: {
        environmentId: "environment-one",
        target: "branch_committed",
        mergeBaseRef: "base-1",
        path: "renamed.txt",
        side: "new",
      },
    });
    expect(
      fixture.calls.some(
        ({ area, args }) =>
          area === "environments.diffFile" &&
          args.target === "all" &&
          args.path === "renamed.txt" &&
          args.side === "old",
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
    const originalDiffFile = fixture.sdk.environments.diffFile;
    fixture.sdk.environments.diffFile = async (args) => {
      const result = await originalDiffFile(args);
      if (
        result.path === "src/file.ts" &&
        args.target === "all" &&
        args.side === "new"
      ) {
        return { ...result, content: "stale", sizeBytes: 5 };
      }
      return result;
    };

    await expect(
      captureWorkspace(fixture.sdk, "environment-one"),
    ).rejects.toThrow(/changed while it was captured/u);
  });

  it("does not hide a missing base read error for a present base path", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    const originalDiffFile = fixture.sdk.environments.diffFile;
    fixture.sdk.environments.diffFile = async (args) => {
      if (args.target === "all" && args.side === "old") {
        throw new Error("base blob unavailable");
      }
      return originalDiffFile(args);
    };

    await expect(
      captureWorkspace(fixture.sdk, "environment-one"),
    ).rejects.toThrow(/base blob unavailable/u);
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
      area: "environments.diffFile",
      args: {
        environmentId: "environment-one",
        target: "all",
        mergeBaseRef: "base-1",
        path: "src/file.ts",
        side: "old",
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
  it("reads workspace status and diffs through the bb--git plugin", async () => {
    const fixture = makeSdk({ files: { "src/file.ts": { content: "new" } } });
    const legacy = fixture.sdk.environments as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    const rpcs: Array<{ method: string; input: Record<string, unknown> }> = [];
    const sdk = {
      ...fixture.sdk,
      environments: { get: legacy.get, diffFiles: legacy.diffFiles, diffFile: legacy.diffFile },
      plugins: {
        callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: Record<string, unknown> }) => {
          if (pluginId !== "bb--git") throw new Error(`Unexpected RPC ${pluginId}.${method}`);
          rpcs.push({ method, input });
          if (method === "workspaceStatus") return legacy.status!(input);
          const { target, ...rest } = input as { target: Record<string, unknown> };
          if (method === "diff") return legacy.diff!({ ...rest, target: target.type, ...(target.mergeBaseBranch ? { mergeBaseBranch: target.mergeBaseBranch } : {}) });
          throw new Error(`Unexpected RPC ${pluginId}.${method}`);
        },
      },
    } as unknown as typeof fixture.sdk;

    expect(await captureWorkspace(sdk, "environment-one")).toMatch(/^[0-9a-f]{64}$/u);
    expect(rpcs).toEqual(expect.arrayContaining([
      { method: "workspaceStatus", input: { environmentId: "environment-one", mergeBaseBranch: "main" } },
      { method: "diff", input: expect.objectContaining({ environmentId: "environment-one", target: { type: "branch_committed", mergeBaseBranch: "main" } }) },
      { method: "diff", input: expect.objectContaining({ environmentId: "environment-one", target: { type: "uncommitted" } }) },
      { method: "diff", input: expect.objectContaining({ environmentId: "environment-one", target: { type: "all", mergeBaseBranch: "main" } }) },
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
      environments: { diffFile: (args: Record<string, unknown>) => Promise<unknown> };
      files: { read: (args: Record<string, unknown>) => Promise<unknown> };
    };
    sdk.environments.diffFile = slow(sdk.environments.diffFile);
    sdk.files.read = slow(sdk.files.read);

    const started = performance.now();
    await captureWorkspace(fixture.sdk, "environment-one");
    // 400 reads at 20 ms each: 2 s with four sequential reads per file and four files at a time.
    expect(performance.now() - started).toBeLessThan(600);
  });
});
