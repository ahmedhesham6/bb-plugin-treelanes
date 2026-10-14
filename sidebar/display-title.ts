import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
export interface GeneratedTitle {
  threadId: string;
  original: string;
  generated: string;
}
export function withGeneratedTitle(
  thread: PluginSidebarThread,
  title?: GeneratedTitle,
): PluginSidebarThread {
  // A human rename always wins, including one made while inference runs.
  return title && thread.title === title.original
    ? { ...thread, title: title.generated }
    : thread;
}
