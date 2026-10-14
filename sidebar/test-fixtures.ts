import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
export function fixture(
  id: string,
  env: string | null = "env",
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    title: id,
    titleFallback: null,
    projectId: "project",
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: env
      ? {
          id: env,
          name: env,
          branchName: "same-branch",
          workspaceDisplayKind: "managed-worktree",
        }
      : null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}
