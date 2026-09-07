import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Sdk = BbPluginApi["sdk"];

type CurrentFile = {
  content: string;
  contentEncoding?: "utf8" | "base64";
};

type DiffTarget = "branch_committed" | "uncommitted" | "all";

type DiffFileFixture = {
  path: string;
  previousPath: string | null;
  changeKind:
    | "added"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "type_changed";
  additions: number;
  deletions: number;
  binary: boolean;
  origin: "tracked" | "untracked";
  loadMode?: "auto" | "on_demand" | "too_large";
};

function availableDiff(diff: string, mergeBaseRef: string | null) {
  return {
    outcome: "available" as const,
    diff: {
      diff,
      files: diff,
      mergeBaseRef,
      shortstat: "1 file changed",
      truncated: false,
    },
  };
}

export function makeWorkspaceSdk(options: {
  files: Record<string, CurrentFile>;
  diffFiles?: DiffFileFixture[];
  diffFilesByTarget?: Partial<Record<DiffTarget, DiffFileFixture[]>>;
  truncated?: boolean;
  statusOutcome?: "available" | "unavailable";
  diffOutcome?: "available" | "unavailable";
}) {
  const calls: Array<{ area: string; args: Record<string, unknown> }> = [];
  const files = new Map(Object.entries(options.files));
  const changedFiles = options.diffFiles ?? [
    {
      path: "src/file.ts",
      previousPath: null,
      changeKind: "modified" as const,
      additions: 1,
      deletions: 1,
      binary: false,
      origin: "tracked" as const,
      loadMode: "auto" as const,
    },
  ];
  const sdk = {
    environments: {
      get: async (args: Record<string, unknown>) => {
        calls.push({ area: "environments.get", args });
        return {
          id: "environment-one",
          projectId: "project-one",
          hostId: "remote-host",
          path: "/srv/worktree",
          status: "ready",
          isGitRepo: true,
          isWorktree: true,
          managed: false,
          workspaceProvisionType: "unmanaged",
          branchName: "feature/review",
          baseBranch: "main",
          defaultBranch: "main",
          mergeBaseBranch: "main",
          name: "Review",
          createdAt: 1,
          updatedAt: 1,
        };
      },
      status: async (args: Record<string, unknown>) => {
        calls.push({ area: "environments.status", args });
        if (options.statusOutcome === "unavailable") {
          return {
            outcome: "unavailable" as const,
            failure: {
              code: "unknown" as const,
              message: "host unavailable",
              workspacePath: "/srv/worktree",
            },
          };
        }
        return {
          outcome: "available" as const,
          workspace: {
            branch: {
              currentBranch: "feature/review",
              defaultBranch: "main",
            },
            checkout: {
              kind: "branch" as const,
              branchName: "feature/review",
              headSha: "head-1",
            },
            mergeBase: {
              mergeBaseBranch: "main",
              baseRef: "base-1",
              aheadCount: 1,
              behindCount: 0,
              commits: [],
              deletions: 1,
              files: [],
              hasCommittedUnmergedChanges: true,
              insertions: 1,
              lineStatsComplete: true,
            },
            workingTree: {
              deletions: 1,
              files: [],
              hasUncommittedChanges: true,
              insertions: 1,
              lineStatsComplete: true,
              state: "dirty_uncommitted" as const,
            },
          },
        };
      },
      diff: async (args: Record<string, unknown>) => {
        calls.push({ area: "environments.diff", args });
        if (options.diffOutcome === "unavailable") {
          return {
            outcome: "unavailable" as const,
            failure: {
              code: "unknown" as const,
              message: "diff unavailable",
              workspacePath: "/srv/worktree",
            },
          };
        }
        const target = args.target as string;
        const mergeBaseRef = target === "uncommitted" ? null : "base-1";
        return availableDiff(`${target}:current`, mergeBaseRef);
      },
      diffFiles: async (args: Record<string, unknown>) => {
        calls.push({ area: "environments.diffFiles", args });
        const target = args.target as DiffTarget;
        const filesForTarget =
          options.diffFilesByTarget?.[target] ?? changedFiles;
        return {
          outcome: "available" as const,
          files: filesForTarget.map((file) => ({
            ...file,
            loadMode: file.loadMode ?? "auto",
          })),
          initialPatches: [],
          mergeBaseRef: args.target === "uncommitted" ? null : "base-1",
          shortstat: "1 file changed",
          truncated: options.truncated ?? false,
        };
      },
      diffFile: async (args: Record<string, unknown>) => {
        calls.push({ area: "environments.diffFile", args });
        return {
          path: args.path,
          content: args.side === "old" ? "old" : files.get(args.path as string)?.content ?? "",
          contentEncoding: "utf8" as const,
          sizeBytes: args.side === "old" ? 3 : (files.get(args.path as string)?.content.length ?? 0),
        };
      },
    },
    files: {
      read: async (args: Record<string, unknown>) => {
        calls.push({ area: "files.read", args });
        const relativePath = (args.path as string).replace("/srv/worktree/", "");
        const file = files.get(relativePath);
        if (!file) throw new Error(`file missing: ${relativePath}`);
        return {
          path: args.path,
          content: file.content,
          contentEncoding: file.contentEncoding ?? "utf8",
          sha256: "0".repeat(64),
          sizeBytes:
            file.contentEncoding === "base64"
              ? Buffer.from(file.content, "base64").byteLength
              : Buffer.byteLength(file.content, "utf8"),
        };
      },
    },
  } as unknown as Sdk;

  return { sdk, calls, files };
}
