import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import {
  experimental_useSidebarThreadSplit as useSplit,
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { groupAttentionItems } from "./groups";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import {
  RowContextMenu,
  RowMenuButton,
  useRegenerateTitle,
} from "./RowContextMenu";
import { ProviderGlyph } from "./ProviderGlyph";
import { StatusOrTime } from "./StatusSlot";
import { CardStatusOrTime } from "./CardStatus";
import { ProjectChip } from "./ProjectChip";
import { MiddleTruncate } from "./MiddleTruncate";
import { threadDisplayTitle, type DropPlacement } from "./inbox";
import { usePullRequest } from "./usePullRequest";
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
  canRegenerateTitle: boolean;
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
    canRegenerateTitle,
    group,
    onMakeMain,
    onSelect,
    shelf = "active",
    wakeAt,
    onRestore,
  } = props;
  const dragged = useRef(false);
  const navigate = useBbNavigate();
  const { splitProps, layout } = useSplit(thread.id);
  const title = threadDisplayTitle(thread);
  const regenerate = useRegenerateTitle(thread.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onSelect?.();
    navigate.toThread(thread.id, { split: event.metaKey || event.ctrlKey });
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
    onRegenerateTitle: canRegenerateTitle ? regenerate.run : undefined,
    regeneratingTitle: regenerate.pending,
  };
  const location = thread.environment?.branchName ?? thread.host?.name ?? "";
  const pr = usePullRequest(thread.environment?.id ?? null);
  const hasThreadsControl = group !== undefined && group.count > 1;
  const metaLineEmpty = !location && !pr && !hasThreadsControl;
  const summary = group?.summary ?? groupAttentionItems([thread]);
  const snoozeLine = shelf === "snoozed" && wakeAt && (
    <p className="pointer-events-none relative mt-1 flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
      <Icon name="Clock" aria-hidden="true" className="size-3.5" />
      <span>{snoozeWakeLabel(wakeAt, now)}</span>
    </p>
  );
  const selectedChildLine = group?.selectedChild && !group.expanded && (
    <p
      className="pointer-events-none relative mt-1 truncate text-xs text-sidebar-foreground"
      title={group.selectedChild}
    >
      Open: {group.selectedChild}
    </p>
  );
  const activityText = Object.entries(thread.activity)
    .filter(([, n]) => n > 0)
    .map(([key, count]) => (
      <span key={key} className="sr-only" aria-label={`${count} ${key}`}>
        {count} {key}
      </span>
    ));
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
            "group/card relative rounded-lg text-sidebar-foreground",
            compact && "px-2.5 py-1.5",
            isDragging && "opacity-50",
            isActive
              ? "bg-state-active bb-sidebar-selected-row"
              : "hover:bg-sidebar-accent",
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
          {compact ? (
            <>
              <div className="pointer-events-none relative flex min-h-7 items-center gap-2 pointer-coarse:min-h-9">
                <span
                  className={cn(
                    "min-w-0 flex-1 self-center truncate text-sm leading-5 pointer-coarse:text-base pointer-coarse:leading-6",
                    thread.isUnread && "font-semibold",
                    regenerate.pending && "text-muted-foreground",
                  )}
                >
                  {title}
                </span>
                {pr && <PullRequest pr={pr} />}
                <span className="grid min-h-7 shrink-0 items-center justify-items-end pointer-coarse:flex pointer-coarse:min-h-9 pointer-coarse:gap-1 pointer-coarse:[&_button]:size-9">
                  <span
                    className={cn(
                      "col-start-1 row-start-1 group-hover/card:opacity-0 group-focus-within/card:opacity-0",
                      menuOpen && "opacity-0",
                    )}
                  >
                    <StatusOrTime thread={thread} now={now} />
                  </span>
                  <span
                    className={cn(
                      "col-start-1 row-start-1 opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 pointer-coarse:opacity-100",
                      menuOpen && "opacity-100",
                    )}
                  >
                    <RowMenuButton {...menu} onOpenChange={setMenuOpen} />
                  </span>
                </span>
                <ProviderGlyph providerId={thread.providerId} />
              </div>
              {activityText}
              {snoozeLine}
              {selectedChildLine}
            </>
          ) : (
            <>
              <div
                data-card-body=""
                className={cn(
                  "pointer-events-none relative h-[4.875rem] px-2.5 py-2 pointer-coarse:h-auto",
                  metaLineEmpty && "h-auto",
                )}
              >
                <div
                  data-card-line="project"
                  className="flex h-5 min-w-0 items-center gap-1.5"
                >
                  {projectName ? (
                    <>
                      <ProjectChip name={projectName} />
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                        title={projectName}
                      >
                        {projectName}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <span
                    data-card-status=""
                    className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end text-xs pointer-coarse:gap-1"
                  >
                    <span
                      data-status-value=""
                      className={cn(
                        "flex items-center tabular-nums text-muted-foreground group-hover/card:opacity-0 group-focus-within/card:opacity-0",
                        menuOpen && "opacity-0",
                      )}
                    >
                      <CardStatusOrTime
                        summary={summary}
                        updatedAt={thread.updatedAt}
                        now={now}
                      />
                    </span>
                    <span
                      data-card-menu=""
                      className={cn(
                        "absolute top-1/2 right-0 -translate-y-1/2 opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 pointer-coarse:static pointer-coarse:-my-3 pointer-coarse:translate-y-0 pointer-coarse:opacity-100",
                        menuOpen && "opacity-100",
                      )}
                    >
                      <RowMenuButton {...menu} onOpenChange={setMenuOpen} />
                    </span>
                  </span>
                </div>
                <div
                  data-card-line="title"
                  className="mt-1 flex min-w-0 items-center gap-1.5"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm leading-5 font-medium pointer-coarse:text-base pointer-coarse:leading-6",
                      thread.isUnread && "font-semibold",
                      regenerate.pending && "text-muted-foreground",
                    )}
                  >
                    {title}
                  </span>
                  {metaLineEmpty && (
                    <ProviderGlyph providerId={thread.providerId} leading />
                  )}
                </div>
                {!metaLineEmpty && (
                  <div
                    data-card-line="meta"
                    className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <ProviderGlyph providerId={thread.providerId} leading />
                    {location ? (
                      <span className="flex min-w-0 flex-1">
                        <MiddleTruncate value={location} />
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {pr && <CardPullRequest pr={pr} />}
                    {group && hasThreadsControl && (
                      <button
                        type="button"
                        aria-label={`${group.expanded ? "Collapse" : "Expand"} ${title}`}
                        aria-expanded={group.expanded}
                        title={
                          group.expanded
                            ? "Hide other threads"
                            : "Show other threads"
                        }
                        onClick={group.toggle}
                        className={cn(
                          "pointer-events-auto -mr-1.5 flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs tabular-nums hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:-my-3.5 pointer-coarse:h-11",
                          group.expanded &&
                            "bg-sidebar-accent text-sidebar-foreground",
                        )}
                      >
                        <span>{group.count} threads</span>
                        <Icon
                          name="ChevronDown"
                          aria-hidden="true"
                          className={cn(
                            "size-4",
                            !group.expanded && "-rotate-90",
                          )}
                        />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <p className="sr-only" aria-live="polite" aria-atomic="true">
                {summary.map((item) => item.label).join(", ")}
              </p>
              {activityText}
              {(snoozeLine || selectedChildLine) && (
                <div className="relative -mt-1 px-2.5 pb-2">
                  {snoozeLine}
                  {selectedChildLine}
                </div>
              )}
            </>
          )}
        </div>
      </li>
    </RowContextMenu>
  );
}

type PullRequestRow = NonNullable<ReturnType<typeof usePullRequest>>;

function PullRequest({ pr }: { pr: PullRequestRow }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={pr.title}
      className={cn(
        "pointer-events-auto relative inline-flex min-h-6 shrink-0 items-center text-xs tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:-my-3.5 pointer-coarse:min-h-11",
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
  );
}

const PULL_REQUEST_STATES: Record<
  PullRequestRow["state"],
  { label: string; icon: string; className: string }
> = {
  open: {
    label: "Open",
    icon: "GitPullRequestArrow",
    className: "text-emerald-600 dark:text-emerald-300/90",
  },
  draft: {
    label: "Draft",
    icon: "GitPullRequestDraft",
    className: "text-zinc-500 dark:text-zinc-400/80",
  },
  closed: {
    label: "Closed",
    icon: "GitPullRequestClosed",
    className: "text-red-600 dark:text-red-300/90",
  },
  merged: {
    label: "Merged",
    icon: "GitMerge",
    className: "text-violet-600 dark:text-violet-300/90",
  },
};

function CardPullRequest({ pr }: { pr: PullRequestRow }) {
  const state = PULL_REQUEST_STATES[pr.state];
  const label = `PR #${pr.number} - ${state.label}: ${pr.title}`;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="pointer-events-auto relative inline-flex shrink-0 items-center gap-0.5 tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:-my-3.5 pointer-coarse:min-h-11"
    >
      <Icon
        name={state.icon}
        aria-hidden="true"
        className={cn("size-3 shrink-0", state.className)}
      />
      <span>{pr.number}</span>
    </a>
  );
}
