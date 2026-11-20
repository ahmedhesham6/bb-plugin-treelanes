import { useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useThreadActions as useThreadActions,
  useBbNavigate,
  useSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { toThreadActionTarget } from "./threadActionTarget";

const ARCHIVE = "bb--core/archive";
const DELETE = "bb--core/delete";
const LIFECYCLE_KEYS = [ARCHIVE, DELETE];

interface Props {
  thread: PluginSidebarThread;
  onMakeMain?: () => void;
  onMove?: (direction: -1 | 1) => void;
  onSettle?: () => void;
  settleLabel?: string;
  onSnooze?: () => void;
  onRestore?: () => void;
  restoreLabel?: string;
  onRegenerateTitle?: () => void;
  regeneratingTitle?: boolean;
}
export function useRegenerateTitle(threadId: string) {
  const sdk = useSdk();
  const [pending, setPending] = useState(false);
  const run = () => {
    setPending(true);
    void sdk.threads
      .experimental_regenerateTitle({ threadId })
      .catch(() => toast.error("Could not regenerate the title. Try again."))
      .finally(() => setPending(false));
  };
  return { pending, run };
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
  onRegenerateTitle,
  regeneratingTitle = false,
}: Props) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  // bb owns archive and delete. Its thread actions hold the confirmations,
  // so the plugin runs them and does not call the API for these two.
  const lifecycle = useThreadActions(toThreadActionTarget(thread), {
    keys: LIFECYCLE_KEYS,
  });
  // bb leaves an action out while it cannot run it, so the item is left out
  // too. An item that does nothing is worse than no item.
  const lifecycleItem = (key: string, label: string, separator?: boolean) => {
    const entry = lifecycle.find((candidate) => candidate.key === key);
    return entry
      ? [{ label, separator, run: () => void entry.action.run() }]
      : [];
  };
  const update = (request: Promise<unknown>) =>
    void request.catch(() =>
      toast.error("Could not update the thread. Try again."),
    );
  const args = { threadId: thread.id };
  return [
    {
      label: "Open in split",
      run: () => navigate.toThread(thread.id, { split: true }),
    },
    {
      label: thread.isUnread ? "Mark read" : "Mark unread",
      run: () =>
        update(
          thread.isUnread
            ? sdk.threads.markRead(args)
            : sdk.threads.markUnread(args),
        ),
    },
    {
      label: thread.isPinned ? "Unpin" : "Pin",
      run: () =>
        update(
          thread.isPinned ? sdk.threads.unpin(args) : sdk.threads.pin(args),
        ),
    },
    ...(onRegenerateTitle
      ? [
          {
            label: regeneratingTitle ? "Regenerating…" : "Regenerate title",
            run: onRegenerateTitle,
            disabled: regeneratingTitle,
          },
        ]
      : []),
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
    ...lifecycleItem(ARCHIVE, "Archive", true),
    ...lifecycleItem(DELETE, "Delete"),
  ] as { label: string; run: () => void; separator?: boolean; disabled?: boolean }[];
}
const menuClass =
  "z-50 min-w-52 rounded-lg border border-border bg-popover p-1.5 shadow-lg text-popover-foreground";
const itemClass =
  "cursor-pointer rounded-md px-3 py-2 text-sm pointer-coarse:min-h-11 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:cursor-default data-[disabled]:text-muted-foreground";
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
              disabled={item.disabled}
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
export function RowMenuButton({
  onOpenChange,
  ...props
}: Props & { onOpenChange?: (open: boolean) => void }) {
  const items = useItems(props);
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
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
              disabled={item.disabled}
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
