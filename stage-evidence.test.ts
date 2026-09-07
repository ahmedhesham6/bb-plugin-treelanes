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
});
