import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreadActions as useActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";

interface Props {
  thread: PluginSidebarThread;
  onMakeMain?: () => void;
  onMove?: (direction: -1 | 1) => void;
  onSettle?: () => void;
  settleLabel?: string;
  onSnooze?: () => void;
  onRestore?: () => void;
  restoreLabel?: string;
}
function useItems({
  thread,
  onMakeMain,
  onMove,
  onSettle,
  settleLabel,
  onSnooze,
  onRestore,
  restoreLabel,
}: Props) {
  const actions = useActions();
  return [
    {
      label: "Open in split",
      run: () => actions.open(thread.id, { split: true }),
    },
    {
      label: thread.isUnread ? "Mark read" : "Mark unread",
      run: () => void actions.setRead(thread.id, thread.isUnread),
    },
    {
      label: thread.isPinned ? "Unpin" : "Pin",
      run: () => void actions.setPinned(thread.id, !thread.isPinned),
    },
    ...(onMakeMain ? [{ label: "Use as main thread", run: onMakeMain }] : []),
    ...(onSettle
      ? [{ label: settleLabel ?? "Settle thread", run: onSettle, separator: true }]
      : []),
    ...(onSnooze ? [{ label: "Snooze until tomorrow", run: onSnooze }] : []),
    ...(onRestore
      ? [
          {
            label: restoreLabel ?? "Restore thread",
            run: onRestore,
            separator: true,
          },
        ]
      : []),
    ...(onMove
      ? [
          { label: "Move up", run: () => onMove(-1), separator: true },
          { label: "Move down", run: () => onMove(1) },
        ]
      : []),
    {
      label: "Archive",
      separator: true,
      run: () => actions.archive(thread.id),
    },
    { label: "Delete", run: () => actions.requestDelete(thread.id) },
  ] as { label: string; run: () => void; separator?: boolean }[];
}
const menuClass =
  "z-50 min-w-52 rounded-lg border border-border bg-popover p-1.5 shadow-lg text-popover-foreground";
const itemClass =
  "cursor-pointer rounded-md px-3 py-2 text-sm pointer-coarse:min-h-11 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";
export function RowContextMenu({
  children,
  ...props
}: Props & { children: ReactNode }) {
  const items = useItems(props);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content aria-label="Thread actions" className={menuClass}>
          {items.map((item) => (
            <ContextMenu.Item
              key={item.label}
              onSelect={item.run}
              className={cn(
                itemClass,
                item.separator && "mt-1 border-t border-border pt-3",
                item.label === "Delete" && "text-destructive-text",
              )}
            >
              {item.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
export function RowMenuButton(props: Props) {
  const items = useItems(props);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${props.thread.title ?? props.thread.titleFallback ?? "thread"}`}
          title="Thread actions"
          className="pointer-events-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        >
          <Icon name="MoreHorizontal" aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          aria-label="Thread actions"
          className={menuClass}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              onSelect={item.run}
              className={cn(
                itemClass,
                item.separator && "mt-1 border-t border-border pt-3",
                item.label === "Delete" && "text-destructive-text",
              )}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
