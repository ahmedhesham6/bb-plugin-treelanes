import { readdirSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Skill folders the plugin ships in skills/. */
export const shippedSkills = readdirSync(new URL("./skills", import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

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
  // The bb--git RPC methods, keyed by method name. A test can replace one.
  const git = {
    workspaceStatus: async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ area: "git.workspaceStatus", args: input });
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
    diff: async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ area: "git.diff", args: input });
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
      const target = (input.target as { type: DiffTarget }).type;
      const mergeBaseRef = target === "uncommitted" ? null : "base-1";
      return availableDiff(`${target}:current`, mergeBaseRef);
    },
    files: async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ area: "git.files", args: input });
      const target = (input.target as { type: DiffTarget }).type;
      const filesForTarget =
        options.diffFilesByTarget?.[target] ?? changedFiles;
      return {
        outcome: "available" as const,
        files: filesForTarget.map((file) => ({
          ...file,
          loadMode: file.loadMode ?? "auto",
          revision: "revision-1",
        })),
        initialPatches: [],
        mergeBaseRef: target === "uncommitted" ? null : "base-1",
        shortstat: "1 file changed",
        truncated: options.truncated ?? false,
      };
    },
    fileSide: async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ area: "git.fileSide", args: input });
      const query = input.query as { path: string; side: "old" | "new" };
      const content = query.side === "old" ? "old" : files.get(query.path)?.content ?? "";
      return {
        outcome: "available" as const,
        file: {
          path: query.path,
          content,
          contentEncoding: "utf8" as const,
          sizeBytes: content.length,
        },
      };
    },
  };
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
    },
    plugins: {
      // The bb--git plugin serves these reads. The fake checks each result
      // against the caller's schema, as bb's API client does.
      callRpc: async ({ pluginId, method, input, outputSchema }: {
        pluginId: string; method: string; input: Record<string, unknown>;
        outputSchema: { parse(value: unknown): unknown };
      }) => {
        const read = pluginId === "bb--git" ? git[method as keyof typeof git] : undefined;
        if (!read) throw new Error(`Unexpected RPC ${pluginId}.${method}`);
        return outputSchema.parse(await read(input));
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

  return { sdk, calls, files, git };
}
