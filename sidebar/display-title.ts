import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { PLUGIN_ID } from "../plugin-id";

/** The most thread ids one listTitles call accepts. */
export const TITLE_BATCH = 500;

/** Only replace names we can identify as machine-generated. */
export function isAutomaticTitle(thread: {
  title: string | null;
  originPluginId: string | null;
}) {
  return (
    thread.originPluginId === PLUGIN_ID &&
    /^Workflow [^\n]+ \[env_[a-z0-9]+(?::[^\]\n]+)?\]$/.test(thread.title ?? "")
  );
}
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
