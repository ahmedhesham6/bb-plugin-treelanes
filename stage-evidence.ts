import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checkNameSchema, deliveryStagesSchema, stageChecksSchema } from "./delivery-plan";
import { setupPlanSchema } from "./setup-plan";

const MAX_TEXT_LENGTH = 4_096;
const MAX_LIST_ITEMS = 128;
const MAX_LIST_ITEM_LENGTH = 1_024;
const MAX_CHANGED_FILES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const FILE_READ_CONCURRENCY = 4;

const boundedText = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
const boundedList = z
  .array(z.string().trim().min(1).max(MAX_LIST_ITEM_LENGTH))
  .max(MAX_LIST_ITEMS);

const completionCheckSchema = z
  .object({
    name: checkNameSchema,
    status: z.enum([
      "passed",
      "failed",
      "skipped",
      "not_run",
      "blocked",
    ]),
    evidence: z.string().max(MAX_TEXT_LENGTH),
    nonTaskFailure: z.object({
      kind: z.enum(["base", "environment"]),
      diagnosis: boundedText.describe("Evidence that this is not a task defect: the compared base revision and failures, or the unavailable external dependency and local diagnosis. Never use for unknown or branch-caused failures."),
    }).strict().optional(),
  })
  .strict();

export const taskContextSchema = z
  .object({
    outcome: boundedText,
    scope: boundedList,
    decisions: boundedList,
    requiredChecks: z.array(checkNameSchema).max(MAX_LIST_ITEMS),
    allowedActions: boundedList,
    deliveryTarget: z.enum(["pr", "local"]).optional(),
    deliveryStages: deliveryStagesSchema.optional(),
    stageChecks: stageChecksSchema.optional(),
    setup: setupPlanSchema.optional(),
    constraints: boundedList.default([]),
    testInterfaces: boundedList.default([]),
    decisionInputs: boundedList.default([]),
    confirmations: boundedList.default([]),
  })
  .strict();

export const completionEvidenceSchema = z
  .object({
    stage: z.enum(["design", "tdd", "quality", "simplify"]),
    // Older tasks did not have a task revision. They remain readable as
    // revision zero; new callers should always save the current revision.
    taskRevision: z.number().int().nonnegative().max(1_000_000).default(0),
    stageUpdatedAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    workspaceDigest: z.string().trim().min(1).max(128),
    checks: z.array(completionCheckSchema).max(MAX_LIST_ITEMS),
    decisionsResolved: z.boolean(),
    openFindings: boundedList,
    summary: boundedText,
    nextAction: z.string().trim().min(1).max(1024).optional()
      .describe("Incomplete TDD, Quality or Simplify: a concrete repair within the saved scope and the check to rerun. Omit for human decisions or external dependencies with no local repair."),
  })
  .strict();

export type TaskContext = z.infer<typeof taskContextSchema>;
export type CompletionEvidence = z.infer<typeof completionEvidenceSchema>;

export const WORKSPACE_CAPTURE_LIMITS = {
  maxChangedFiles: MAX_CHANGED_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalFileBytes: MAX_TOTAL_FILE_BYTES,
  maxDiffBytes: MAX_DIFF_BYTES,
} as const;

type Sdk = BbPluginApi["sdk"];
type Hash = ReturnType<typeof createHash>;

type DiffTarget = "branch_committed" | "uncommitted" | "all";
type DiffResponse = Awaited<ReturnType<Sdk["environments"]["diff"]>>;
type DiffFilesResponse = Awaited<
  ReturnType<Sdk["environments"]["diffFiles"]>
>;
type DiffFileResponse = Awaited<
  ReturnType<Sdk["environments"]["diffFile"]>
>;
type FileReadResponse = Awaited<ReturnType<Sdk["files"]["read"]>>;

type ChangedFile = Extract<
  DiffFilesResponse,
  { outcome: "available" }
>["files"][number];

type FilePresence = {
  base: boolean;
  head: boolean;
  worktree: boolean;
};

type WorkspaceStatus = Extract<
  Awaited<ReturnType<Sdk["environments"]["status"]>>,
  { outcome: "available" }
>["workspace"];

type WorkspaceSnapshot = {
  environment: Awaited<ReturnType<Sdk["environments"]["get"]>>;
  status: WorkspaceStatus;
  baseRef: string;
  headSha: string;
  mergeBaseBranch: string;
  diffs: Record<DiffTarget, Extract<DiffResponse, { outcome: "available" }>>;
  files: ChangedFile[];
  branchFiles: ChangedFile[];
};

export class WorkspaceCaptureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceCaptureError";
  }
}

function unavailable(message: string): never {
  throw new WorkspaceCaptureError(`Workspace snapshot unavailable: ${message}`);
}

function assertNonEmpty(value: string | null | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return unavailable(`${label} is missing`);
  }
  return value;
}

function assertAvailable<T extends { outcome: string }>(
  result: T,
  label: string,
): Extract<T, { outcome: "available" }> {
  if (result.outcome !== "available") {
    return unavailable(`${label} is ${result.outcome}`);
  }
  return result as Extract<T, { outcome: "available" }>;
}

async function readSdk<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceCaptureError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkspaceCaptureError(
      `Workspace snapshot unavailable while reading ${label}: ${detail}`,
      { cause: error },
    );
  }
}

function assertBoundedText(value: string, label: string): void {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_DIFF_BYTES) {
    unavailable(`${label} exceeds the ${MAX_DIFF_BYTES}-byte limit`);
  }
}

function assertRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === ".." || part === "")
  ) {
    unavailable(`changed path is invalid: ${JSON.stringify(relativePath)}`);
  }
}

function workspacePath(rootPath: string, relativePath: string): string {
  assertRelativePath(relativePath);
  const separator = rootPath.includes("\\") ? "\\" : "/";
  return `${rootPath.replace(/[\\/]+$/u, "")}${separator}${relativePath.replaceAll("/", separator)}`;
}

function decodeContent(
  result: Pick<DiffFileResponse, "content" | "contentEncoding" | "sizeBytes"> | Pick<FileReadResponse, "content" | "contentEncoding" | "sizeBytes">,
  label: string,
): Buffer {
  if (result.sizeBytes < 0 || result.sizeBytes > MAX_FILE_BYTES) {
    unavailable(`${label} exceeds the ${MAX_FILE_BYTES}-byte file limit`);
  }

  if (
    result.contentEncoding === "base64" &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      result.content,
    )
  ) {
    unavailable(`${label} returned invalid base64 content`);
  }

  const bytes = Buffer.from(
    result.content,
    result.contentEncoding === "base64" ? "base64" : "utf8",
  );
  if (bytes.byteLength !== result.sizeBytes) {
    unavailable(
      `${label} returned ${bytes.byteLength} bytes but declared ${result.sizeBytes}`,
    );
  }
  return bytes;
}

function frame(hash: Hash, label: string, value: string | Uint8Array): void {
  const labelBytes = Buffer.from(label, "utf8");
  const valueBytes =
    typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(Buffer.from(`${labelBytes.byteLength}:`, "ascii"));
  hash.update(labelBytes);
  hash.update(Buffer.from(`${valueBytes.byteLength}:`, "ascii"));
  hash.update(valueBytes);
}

function frameText(hash: Hash, label: string, value: string): void {
  frame(hash, label, value);
}

function frameJson(hash: Hash, label: string, value: unknown): void {
  frameText(hash, label, JSON.stringify(value));
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function changedPathSet(files: readonly ChangedFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    assertRelativePath(file.path);
    paths.add(file.path);
    if (file.previousPath !== null) {
      assertRelativePath(file.previousPath);
      paths.add(file.previousPath);
    }
  }
  return [...paths].sort(compareStrings);
}

function recordPresence(
  presence: Map<string, FilePresence>,
  relativePath: string,
  sides: FilePresence,
): void {
  assertRelativePath(relativePath);
  const existing = presence.get(relativePath);
  if (
    existing !== undefined &&
    (existing.base !== sides.base ||
      existing.head !== sides.head ||
      existing.worktree !== sides.worktree)
  ) {
    unavailable(`changed-file metadata conflicts for ${relativePath}`);
  }
  presence.set(relativePath, sides);
}

function recordBaseAndWorktreePresence(
  presence: Map<string, FilePresence>,
  file: ChangedFile,
): void {
  if (file.origin === "untracked") {
    if (file.changeKind !== "added" || file.previousPath !== null) {
      unavailable(`untracked file metadata is invalid: ${file.path}`);
    }
    recordPresence(presence, file.path, {
      base: false,
      head: false,
      worktree: true,
    });
    return;
  }

  switch (file.changeKind) {
    case "added":
      recordPresence(presence, file.path, {
        base: false,
        head: false,
        worktree: true,
      });
      return;
    case "deleted":
      recordPresence(presence, file.path, {
        base: true,
        head: false,
        worktree: false,
      });
      return;
    case "modified":
    case "type_changed":
      recordPresence(presence, file.path, {
        base: true,
        head: false,
        worktree: true,
      });
      return;
    case "renamed":
      if (file.previousPath === null) {
        unavailable(`rename metadata has no old path: ${file.path}`);
      }
      recordPresence(presence, file.previousPath, {
        base: true,
        head: false,
        worktree: false,
      });
      recordPresence(presence, file.path, {
        base: false,
        head: false,
        worktree: true,
      });
      return;
    case "copied":
      if (file.previousPath === null) {
        unavailable(`copy metadata has no source path: ${file.path}`);
      }
      recordPresence(presence, file.previousPath, {
        base: true,
        head: false,
        worktree: true,
      });
      recordPresence(presence, file.path, {
        base: false,
        head: false,
        worktree: true,
      });
      return;
    default: {
      const exhaustive: never = file.changeKind;
      unavailable(`unsupported changed-file metadata: ${exhaustive}`);
    }
  }
}

function recordHeadPresence(
  presence: Map<string, boolean>,
  file: ChangedFile,
): void {
  if (file.origin === "untracked") {
    unavailable(`committed diff contains an untracked file: ${file.path}`);
  }

  const record = (relativePath: string, exists: boolean): void => {
    assertRelativePath(relativePath);
    const existing = presence.get(relativePath);
    if (existing !== undefined && existing !== exists) {
      unavailable(`committed changed-file metadata conflicts for ${relativePath}`);
    }
    presence.set(relativePath, exists);
  };

  switch (file.changeKind) {
    case "added":
    case "modified":
    case "type_changed":
      record(file.path, true);
      return;
    case "deleted":
      record(file.path, false);
      return;
    case "renamed":
      if (file.previousPath === null) {
        unavailable(`committed rename metadata has no old path: ${file.path}`);
      }
      record(file.previousPath, false);
      record(file.path, true);
      return;
    case "copied":
      if (file.previousPath === null) {
        unavailable(`committed copy metadata has no source path: ${file.path}`);
      }
      record(file.previousPath, true);
      record(file.path, true);
      return;
    default: {
      const exhaustive: never = file.changeKind;
      unavailable(`unsupported committed file metadata: ${exhaustive}`);
    }
  }
}

function deriveFilePresence(
  files: readonly ChangedFile[],
  branchFiles: readonly ChangedFile[],
): Map<string, FilePresence> {
  const baseAndWorktree = new Map<string, FilePresence>();
  for (const file of files) {
    recordBaseAndWorktreePresence(baseAndWorktree, file);
  }

  const headPresence = new Map<string, boolean>();
  for (const file of branchFiles) {
    recordHeadPresence(headPresence, file);
  }

  const presence = new Map<string, FilePresence>();
  for (const [relativePath, sides] of baseAndWorktree) {
    recordPresence(presence, relativePath, {
      ...sides,
      head: headPresence.get(relativePath) ?? sides.base,
    });
  }
  return presence;
}

function assertDiffResult(
  result: Extract<DiffResponse, { outcome: "available" }>,
  target: DiffTarget,
  baseRef: string,
): void {
  if (result.diff.truncated) {
    unavailable(`${target} diff is truncated`);
  }
  assertBoundedText(result.diff.diff, `${target} diff`);
  assertBoundedText(result.diff.files, `${target} file list`);
  if (target === "uncommitted") {
    if (result.diff.mergeBaseRef !== null) {
      unavailable("uncommitted diff unexpectedly has a merge base");
    }
  } else if (result.diff.mergeBaseRef !== baseRef) {
    unavailable(`${target} diff does not use the captured merge base`);
  }
}

function assertDiffFilesResult(
  result: Extract<DiffFilesResponse, { outcome: "available" }>,
  baseRef: string,
): ChangedFile[] {
  if (result.truncated) {
    unavailable("changed-file list is truncated");
  }
  if (result.mergeBaseRef !== baseRef) {
    unavailable("changed-file list does not use the captured merge base");
  }
  if (result.files.length > MAX_CHANGED_FILES) {
    unavailable(
      `changed-file list exceeds the ${MAX_CHANGED_FILES}-file limit`,
    );
  }
  if (
    !Array.isArray(result.initialPatches) ||
    result.initialPatches.length > MAX_CHANGED_FILES ||
    result.initialPatches.some((patch) => patch.truncated)
  ) {
    unavailable("initial diff patches are incomplete");
  }
  for (const file of result.files) {
    assertRelativePath(file.path);
    if (file.previousPath !== null) assertRelativePath(file.previousPath);
    if (file.loadMode === "too_large") {
      unavailable(`changed file is too large: ${file.path}`);
    }
  }
  return result.files;
}

async function captureSnapshot(
  sdk: Sdk,
  environmentId: string,
): Promise<WorkspaceSnapshot> {
  const environment = await readSdk("environment", () =>
    sdk.environments.get({ environmentId }),
  );
  if (environment.status !== "ready") {
    unavailable(`environment is ${environment.status}`);
  }
  if (!environment.isGitRepo || environment.path === null) {
    unavailable("environment has no Git workspace path");
  }

  const mergeBaseBranch = assertNonEmpty(
    environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch,
    "merge base branch",
  );
  const statusResult = await readSdk("workspace status", () =>
    sdk.environments.status({ environmentId, mergeBaseBranch }),
  );
  const status = assertAvailable(statusResult, "workspace status");
  const workspace = status.workspace;
  const checkoutHeadSha =
    "headSha" in workspace.checkout ? workspace.checkout.headSha : null;
  const headSha = assertNonEmpty(
    checkoutHeadSha,
    "workspace HEAD",
  );
  const mergeBase = workspace.mergeBase;
  if (mergeBase === null) unavailable("workspace has no merge base");
  const baseRef = assertNonEmpty(mergeBase.baseRef, "workspace merge base ref");
  if (mergeBase.mergeBaseBranch !== mergeBaseBranch) {
    unavailable("workspace status used a different merge base branch");
  }
  if (!mergeBase.lineStatsComplete || !workspace.workingTree.lineStatsComplete) {
    unavailable("workspace status is incomplete");
  }
  if (
    mergeBase.files.length > MAX_CHANGED_FILES ||
    workspace.workingTree.files.length > MAX_CHANGED_FILES ||
    mergeBase.commits.length > MAX_CHANGED_FILES
  ) {
    unavailable(`workspace status exceeds the ${MAX_CHANGED_FILES}-item limit`);
  }

  const [
    branchDiffResult,
    uncommittedDiffResult,
    allDiffResult,
    diffFilesResult,
    branchDiffFilesResult,
  ] = await Promise.all([
      readSdk("committed branch diff", () =>
        sdk.environments.diff({
          environmentId,
          target: "branch_committed",
          mergeBaseBranch,
        }),
      ),
      readSdk("uncommitted diff", () =>
        sdk.environments.diff({ environmentId, target: "uncommitted" }),
      ),
      readSdk("combined workspace diff", () =>
        sdk.environments.diff({
          environmentId,
          target: "all",
          mergeBaseBranch,
        }),
      ),
      readSdk("changed-file list", () =>
        sdk.environments.diffFiles({
          environmentId,
          target: "all",
          mergeBaseBranch,
        }),
      ),
      readSdk("committed changed-file list", () =>
        sdk.environments.diffFiles({
          environmentId,
          target: "branch_committed",
          mergeBaseBranch,
        }),
      ),
    ]);

  const branchDiff = assertAvailable(branchDiffResult, "committed branch diff");
  const uncommittedDiff = assertAvailable(
    uncommittedDiffResult,
    "uncommitted diff",
  );
  const allDiff = assertAvailable(allDiffResult, "combined workspace diff");
  assertDiffResult(branchDiff, "branch_committed", baseRef);
  assertDiffResult(uncommittedDiff, "uncommitted", baseRef);
  assertDiffResult(allDiff, "all", baseRef);
  const files = assertDiffFilesResult(
    assertAvailable(diffFilesResult, "changed-file list"),
    baseRef,
  );
  const branchFiles = assertDiffFilesResult(
    assertAvailable(
      branchDiffFilesResult,
      "committed changed-file list",
    ),
    baseRef,
  );

  return {
    environment,
    status: workspace,
    baseRef,
    headSha,
    mergeBaseBranch,
    diffs: {
      branch_committed: branchDiff,
      uncommitted: uncommittedDiff,
      all: allDiff,
    },
    files,
    branchFiles,
  };
}

function frameSnapshotMetadata(hash: Hash, snapshot: WorkspaceSnapshot): void {
  frameText(hash, "format", "workflow-board-workspace-v1");
  frameText(hash, "head", snapshot.headSha);
  frameText(hash, "merge-base-branch", snapshot.mergeBaseBranch);
  frameText(hash, "merge-base-ref", snapshot.baseRef);
  frameText(hash, "checkout-kind", snapshot.status.checkout.kind);
  frameText(hash, "branch", snapshot.status.branch.currentBranch ?? "");
  frameText(hash, "working-tree-state", snapshot.status.workingTree.state);
  frameJson(hash, "working-tree-flags", {
    hasUncommittedChanges: snapshot.status.workingTree.hasUncommittedChanges,
    insertions: snapshot.status.workingTree.insertions,
    deletions: snapshot.status.workingTree.deletions,
  });
  const statusFiles = (files: readonly {
    path: string;
    status: string;
    insertions: number | null;
    deletions: number | null;
  }[]) =>
    [...files]
      .map((file) => ({
        path: file.path,
        status: file.status,
        insertions: file.insertions,
        deletions: file.deletions,
      }))
      .sort((left, right) => compareStrings(left.path, right.path));
  frameJson(hash, "merge-base-files", statusFiles(snapshot.status.mergeBase?.files ?? []));
  frameJson(hash, "working-tree-files", statusFiles(snapshot.status.workingTree.files));
  for (const target of ["branch_committed", "uncommitted", "all"] as const) {
    const diff = snapshot.diffs[target].diff;
    frameText(hash, `diff:${target}`, diff.diff);
    frameText(hash, `file-list:${target}`, diff.files);
    frameText(hash, `shortstat:${target}`, diff.shortstat);
  }
}

function frameChangedFileMetadata(hash: Hash, files: readonly ChangedFile[]): void {
  const sorted = [...files].sort((left, right) => {
    const pathOrder = compareStrings(left.path, right.path);
    if (pathOrder !== 0) return pathOrder;
    const previousPathOrder = compareStrings(
      left.previousPath ?? "",
      right.previousPath ?? "",
    );
    if (previousPathOrder !== 0) return previousPathOrder;
    return compareStrings(left.origin, right.origin);
  });
  for (const file of sorted) {
    frameJson(hash, "changed-file", {
      path: file.path,
      previousPath: file.previousPath,
      changeKind: file.changeKind,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      origin: file.origin,
    });
  }
}

async function frameFileContents(
  hash: Hash,
  sdk: Sdk,
  environmentId: string,
  hostId: string,
  rootPath: string,
  baseRef: string,
  paths: readonly string[],
  presence: ReadonlyMap<string, FilePresence>,
): Promise<void> {
  let totalBytes = 0;
  for (let start = 0; start < paths.length; start += FILE_READ_CONCURRENCY) {
    const batch = paths.slice(start, start + FILE_READ_CONCURRENCY);
    const rows = await Promise.all(
      batch.map(async (relativePath) => {
        const sides = presence.get(relativePath);
        if (sides === undefined) {
          unavailable(`changed path has no presence metadata: ${relativePath}`);
        }
        const baseBytes = sides.base
          ? decodeContent(
              await readSdk(`base file ${relativePath}`, () =>
                sdk.environments.diffFile({
                  environmentId,
                  target: "all",
                  mergeBaseRef: baseRef,
                  path: relativePath,
                  side: "old",
                }),
              ),
              `base file ${relativePath}`,
            )
          : new Uint8Array(0);
        const headBytes = sides.head
          ? decodeContent(
              await readSdk(`HEAD file ${relativePath}`, () =>
                sdk.environments.diffFile({
                  environmentId,
                  target: "branch_committed",
                  mergeBaseRef: baseRef,
                  path: relativePath,
                  side: "new",
                }),
              ),
              `HEAD file ${relativePath}`,
            )
          : new Uint8Array(0);
        let worktreeBytes: Uint8Array = new Uint8Array(0);
        if (sides.worktree) {
          const diffWorktreeResult = await readSdk(
            `diff worktree file ${relativePath}`,
            () =>
              sdk.environments.diffFile({
                environmentId,
                target: "all",
                mergeBaseRef: baseRef,
                path: relativePath,
                side: "new",
              }),
          );
          const diffWorktreeBytes = decodeContent(
            diffWorktreeResult,
            `diff worktree file ${relativePath}`,
          );
          const currentResult = await readSdk(
            `current file ${relativePath}`,
            () =>
              sdk.files.read({
                hostId,
                path: workspacePath(rootPath, relativePath),
                rootPath,
              }),
          );
          worktreeBytes = decodeContent(
            currentResult,
            `current file ${relativePath}`,
          );
          if (Buffer.compare(diffWorktreeBytes, worktreeBytes) !== 0) {
            unavailable(
              `current file ${relativePath} changed while it was captured`,
            );
          }
        }
        return { relativePath, baseBytes, headBytes, worktreeBytes };
      }),
    );

    for (const row of rows) {
      totalBytes +=
        row.baseBytes.byteLength +
        row.headBytes.byteLength +
        row.worktreeBytes.byteLength;
      if (totalBytes > MAX_TOTAL_FILE_BYTES) {
        unavailable(
          `captured file content exceeds the ${MAX_TOTAL_FILE_BYTES}-byte limit`,
        );
      }
      frameText(hash, "path", row.relativePath);
      frame(hash, "base-content", row.baseBytes);
      frame(hash, "head-content", row.headBytes);
      frame(hash, "worktree-content", row.worktreeBytes);
    }
  }
}

export async function captureWorkspace(
  sdk: BbPluginApi["sdk"],
  environmentId: string,
): Promise<string> {
  const snapshot = await captureSnapshot(sdk, environmentId);
  const hash = createHash("sha256");
  frameSnapshotMetadata(hash, snapshot);
  frameChangedFileMetadata(hash, snapshot.files);
  frameChangedFileMetadata(hash, snapshot.branchFiles);
  const presence = deriveFilePresence(snapshot.files, snapshot.branchFiles);
  await frameFileContents(
    hash,
    sdk,
    environmentId,
    snapshot.environment.hostId,
    assertNonEmpty(snapshot.environment.path, "environment path"),
    snapshot.baseRef,
    changedPathSet(snapshot.files),
    presence,
  );
  return hash.digest("hex");
}
