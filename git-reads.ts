import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The reads Treelanes makes from bb's Git plugin (`bb--git`): workspace
 * status, diffs, changed files and file sides.
 *
 * The schemas are copies of the parts of that plugin's RPC contract that the
 * worktree digest reads (bb's `plugins/git/contract.ts`). Fields the digest
 * does not read are left out, and values it only passes through stay plain
 * strings, so a newer bb can add fields and kinds without failing a read.
 *
 * A call rejects when the Git plugin is disabled or the result does not match.
 */
type Sdk = BbPluginApi["sdk"];

const GIT_PLUGIN_ID = "bb--git";

const notApplicableSchema = z.object({ outcome: z.literal("not_applicable") });
const unavailableSchema = z.object({ outcome: z.literal("unavailable") });

const workspaceFileStatusSchema = z.object({
  path: z.string(),
  status: z.string(),
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});

const workspaceChangeStatsSchema = z.object({
  insertions: z.number(),
  deletions: z.number(),
  lineStatsComplete: z.boolean(),
  files: z.array(workspaceFileStatusSchema),
});

const workspaceStatusSchema = z.object({
  workingTree: workspaceChangeStatsSchema.extend({
    hasUncommittedChanges: z.boolean(),
    state: z.string(),
  }),
  checkout: z.object({
    kind: z.string(),
    headSha: z.string().nullable().optional(),
  }),
  branch: z.object({ currentBranch: z.string().nullable() }),
  mergeBase: workspaceChangeStatsSchema
    .extend({
      mergeBaseBranch: z.string(),
      baseRef: z.string().nullable(),
      commits: z.array(z.unknown()),
    })
    .nullable(),
});

const gitStatusResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    workspace: workspaceStatusSchema,
  }),
  notApplicableSchema,
  unavailableSchema,
]);

const gitDiffResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    diff: z.object({
      diff: z.string(),
      truncated: z.boolean(),
      shortstat: z.string(),
      files: z.string(),
      mergeBaseRef: z.string().nullable(),
    }),
  }),
  notApplicableSchema,
  unavailableSchema,
]);

const diffFileEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type_changed",
  ]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  origin: z.enum(["tracked", "untracked"]),
  loadMode: z.string(),
});

const gitFilesResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(diffFileEntrySchema),
    truncated: z.boolean(),
    shortstat: z.string(),
    mergeBaseRef: z.string().nullable(),
    initialPatches: z.array(
      z.object({
        path: z.string(),
        patch: z.string(),
        truncated: z.boolean(),
      }),
    ),
  }),
  notApplicableSchema,
  unavailableSchema,
]);

const gitFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf8"]),
  sizeBytes: z.number(),
});

const gitFileSideResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), file: gitFileContentSchema }),
  z.object({
    outcome: z.literal("unavailable"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type GitDiffTarget =
  | { type: "uncommitted" }
  | { type: "branch_committed" | "all"; mergeBaseBranch: string };

export type GitFileSideQuery = {
  target: "branch_committed" | "all";
  mergeBaseRef: string;
  path: string;
  side: "old" | "new";
};

export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;
export type GitDiffResult = z.infer<typeof gitDiffResultSchema>;
export type GitFilesResult = z.infer<typeof gitFilesResultSchema>;
export type GitFileContent = z.infer<typeof gitFileContentSchema>;

export function readGitWorkspaceStatus(
  sdk: Sdk,
  input: { environmentId: string; mergeBaseBranch: string },
): Promise<GitStatusResult> {
  return sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN_ID,
    method: "workspaceStatus",
    input,
    outputSchema: gitStatusResultSchema,
  });
}

export function readGitDiff(
  sdk: Sdk,
  input: { environmentId: string; target: GitDiffTarget },
): Promise<GitDiffResult> {
  return sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN_ID,
    method: "diff",
    input,
    outputSchema: gitDiffResultSchema,
  });
}

export function readGitFiles(
  sdk: Sdk,
  input: { environmentId: string; target: GitDiffTarget },
): Promise<GitFilesResult> {
  return sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN_ID,
    method: "files",
    input: { ...input, ignoreWhitespace: false },
    outputSchema: gitFilesResultSchema,
  });
}

/**
 * One side of one changed file. Rejects with the Git plugin's message when
 * the side is not available, so a caller has one failure path for each read.
 */
export async function readGitFileSide(
  sdk: Sdk,
  input: { environmentId: string; query: GitFileSideQuery },
): Promise<GitFileContent> {
  const result = await sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN_ID,
    method: "fileSide",
    input,
    outputSchema: gitFileSideResultSchema,
  });
  if (result.outcome !== "available") throw new Error(result.message);
  return result.file;
}
