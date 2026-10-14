import { useRef, type DragEvent, type MouseEvent } from "react";
import {
  experimental_useSidebarThreadPullRequest as usePullRequest,
  experimental_useSidebarThreadSplit as useSplit,
  experimental_useSidebarThreadActions as useActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { RunningDot } from "./RunningDot";
import type { groupAttentionItems } from "./groups";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { RowContextMenu, RowMenuButton } from "./RowContextMenu";
import { ProviderGlyph } from "./ProviderGlyph";
import { StatusOrTime } from "./StatusSlot";
import { threadDisplayTitle, type DropPlacement } from "./inbox";
import {
  resolveSnoozePresets,
  snoozeWakeLabel,
  type ThreadShelf,
} from "./lifecycle";

export interface ThreadCardProps {
  thread: PluginSidebarThread;
  projectName: string | null;
  isActive: boolean;
  canPark: boolean;
  onNavigate: () => void;
  onSettle: () => void;
  onSnooze: (until: number) => void;
  isDragging: boolean;
  dropPlacement: DropPlacement | null;
  onDragStart: (event: DragEvent<HTMLAnchorElement>) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onMove: (direction: -1 | 1) => void;
  now: number;
  compact?: boolean;
  group?: {
    count: number;
    canSettle: boolean;
    expanded: boolean;
    toggle: () => void;
    summary: ReturnType<typeof groupAttentionItems>;
    selectedChild: string | null;
  };
  onMakeMain?: () => void;
  onSelect?: () => void;
  shelf?: ThreadShelf;
  wakeAt?: number | null;
  onRestore?: () => void;
}
export function ThreadCard(props: ThreadCardProps) {
  const {
    thread,
    projectName,
    isActive,
    canPark,
    onNavigate,
    onSettle,
    onSnooze,
    isDragging,
    dropPlacement,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onMove,
    now,
    compact = false,
    group,
    onMakeMain,
    onSelect,
    shelf = "active",
    wakeAt,
    onRestore,
  } = props;
  const dragged = useRef(false);
  const actions = useActions();
  const { splitProps, layout } = useSplit(thread.id);
  const title = threadDisplayTitle(thread);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onSelect?.();
    actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
    onNavigate();
  };
  const park = canPark && shelf === "active";
  const tomorrow = resolveSnoozePresets(new Date()).find(
    (p) => p.id === "tomorrow",
  )!;
  const menu = {
    thread,
    onMakeMain,
    onMove,
    onSettle: (group ? group.canSettle : park) ? onSettle : undefined,
    settleLabel: group && group.count > 1 ? "Settle all threads" : "Settle thread",
    onSnooze: park ? () => onSnooze(tomorrow.snoozedUntil) : undefined,
    onRestore: shelf !== "active" ? onRestore : undefined,
    restoreLabel: shelf === "snoozed" ? "Wake thread now" : "Restore thread",
  };
  const location = thread.environment?.branchName ?? thread.host?.name ?? "";
  return (
    <RowContextMenu {...menu}>
      <li
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={cn(
          "relative list-none",
          compact ? "ml-5 border-l border-sidebar-border pl-2" : "mt-1",
        )}
      >
        {dropPlacement && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-1 z-20 h-0.5 bg-primary",
              dropPlacement === "before" ? "top-0" : "bottom-0",
            )}
          />
        )}
        <div
          className={cn(
            "group/card relative rounded-lg px-2.5 text-sidebar-foreground",
            compact ? "py-1.5" : "py-2",
            isDragging && "opacity-50",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            !isActive &&
              (layout !== null || group?.expanded) &&
              "bg-sidebar-accent/30",
          )}
        >
          {isActive && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-3 left-0 w-0.5 rounded-full bg-sidebar-primary"
            />
          )}
          <a
            {...splitProps}
            draggable
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={title}
            aria-current={isActive ? "page" : undefined}
            title={title}
            onPointerDown={(event) => {
              dragged.current = false;
              if (event.shiftKey) splitProps.onPointerDown?.(event);
            }}
            onDragStart={(event) => {
              if (event.shiftKey) {
                event.preventDefault();
                return;
              }
              dragged.current = true;
              event.dataTransfer.setDragImage(
                event.currentTarget.parentElement!,
                20,
                20,
              );
              onDragStart(event);
            }}
            onDragEnd={onDragEnd}
            onClick={open}
            className="absolute inset-0 cursor-pointer rounded-lg active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="pointer-events-none relative flex min-h-7 items-start gap-2 pointer-coarse:min-h-11">
            <span
              className={cn(
                "min-w-0 flex-1 self-center break-words text-sm leading-5 pointer-coarse:text-base pointer-coarse:leading-6",
                compact ? "line-clamp-2" : "line-clamp-2 font-medium",
                thread.isUnread && "font-semibold",
              )}
            >
              {title}
            </span>
            <span className="flex min-h-7 shrink-0 items-center gap-1 pointer-coarse:min-h-11">
              <StatusOrTime thread={thread} now={now} />
              <RowMenuButton {...menu} />
            </span>
          </div>
          {group && group.summary.length > 0 && (
            <p
              className="pointer-events-none relative mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground"
              aria-live="polite"
              aria-atomic="true"
            >
              {group.summary.map((item) => (
                <span
                  key={item.kind}
                  className="inline-flex items-center gap-1.5"
                >
                  {item.kind === "running" && <RunningDot />}
                  {item.label}
                </span>
              ))}
            </p>
          )}
          {!compact && (
            <div className="pointer-events-none relative mt-1 flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
              <ProviderGlyph providerId={thread.providerId} />
              <span
                className="min-w-0 flex-1 truncate"
                title={[projectName, location].filter(Boolean).join(" / ")}
              >
                {projectName && <span>{projectName}</span>}
                {projectName && location && <span aria-hidden="true"> / </span>}
                <span>{location}</span>
              </span>
              <PullRequest threadId={thread.id} />
              {group && group.count > 1 && (
                <button
                  type="button"
                  aria-label={`${group.expanded ? "Collapse" : "Expand"} ${title}`}
                  aria-expanded={group.expanded}
                  title={
                    group.expanded ? "Hide other threads" : "Show other threads"
                  }
                  onClick={group.toggle}
                  className={cn(
                    "pointer-events-auto flex min-h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs tabular-nums hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
                    group.expanded &&
                      "bg-sidebar-accent text-sidebar-foreground",
                  )}
                >
                  <span>{group.count} threads</span>
                  <Icon
                    name="ChevronDown"
                    aria-hidden="true"
                    className={cn("size-4", !group.expanded && "-rotate-90")}
                  />
                </button>
              )}
            </div>
          )}
          {compact && <PullRequest threadId={thread.id} compact />}
          {compact && (
            <span className="sr-only">
              <ProviderGlyph providerId={thread.providerId} />
            </span>
          )}
          {Object.entries(thread.activity)
            .filter(([, n]) => n > 0)
            .map(([key, count]) => (
              <span
                key={key}
                className="sr-only"
                aria-label={`${count} ${key}`}
              >
                {count} {key}
              </span>
            ))}
          {shelf === "snoozed" && wakeAt && (
            <p className="pointer-events-none relative mt-1 flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <Icon name="Clock" aria-hidden="true" className="size-3.5" />
              <span>{snoozeWakeLabel(wakeAt, now)}</span>
            </p>
          )}
          {group?.selectedChild && !group.expanded && (
            <p
              className="pointer-events-none relative mt-1 truncate text-xs text-sidebar-foreground"
              title={group.selectedChild}
            >
              Open: {group.selectedChild}
            </p>
          )}
        </div>
      </li>
    </RowContextMenu>
  );
}

function PullRequest({
  threadId,
  compact = false,
}: {
  threadId: string;
  compact?: boolean;
}) {
  const { pullRequest: pr } = usePullRequest(threadId);
  return (
    pr && (
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={pr.title}
        className={cn(
          "pointer-events-auto relative inline-flex min-h-6 shrink-0 items-center text-xs tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
          compact && "mt-1",
          pr.state === "merged"
            ? "text-[color:var(--pr-merged)]"
            : pr.attention === "checks_failed" || pr.attention === "conflicts"
              ? "text-destructive-text"
              : pr.attention === "ready_to_merge"
                ? "text-success-foreground"
                : "text-muted-foreground",
        )}
      >
        #{pr.number}
      </a>
    )
  );
}
