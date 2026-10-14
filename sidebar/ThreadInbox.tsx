import { useTitledThreads as useThreads } from "./useTitledThreads";
import { cn } from "../lib/utils";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "./components/Icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/Select";
import { useSelectionAnchor } from "./useSelectionAnchor";
import { ThreadCard } from "./ThreadCard";
import { useLifecycle } from "./useLifecycle";
import { useThreadOrder } from "./useThreadOrder";
import { useGroups } from "./useGroups";
import { useDragAutoScroll } from "./useDragAutoScroll";
import {
  buildGroups,
  groupAttentionItems,
  moveRelative,
  worktreeKey,
  type ThreadGroup,
} from "./groups";
import {
  sortByManualOrder,
  threadDisplayTitle,
  type DropPlacement,
} from "./inbox";
import type { ThreadShelf } from "./lifecycle";

export function ThreadInbox({
  activeThreadId,
  onNavigate,
  searchQuery,
  Original,
}: PluginThreadListProps) {
  const { status, threads, projects } = useThreads();
  const lifecycle = useLifecycle(threads);
  const order = useThreadOrder();
  const saved = useGroups();
  const scroll = useDragAutoScroll();
  const [scope, setScope] = useState("all");
  const [expansion, setExpansion] = useState<{
    selection: string | null;
    group: string | null;
  }>({ selection: null, group: null });
  const [openShelves, setOpenShelves] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<{
    threadId: string;
    groupId: string;
    main: boolean;
  } | null>(null);
  const [drop, setDrop] = useState<{
    id: string;
    placement: DropPlacement;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const groups = useMemo(
    () =>
      buildGroups(
        threads,
        saved.mains,
        saved.preferred,
        order.order,
        lifecycle.shelfFor,
      ),
    [threads, saved.mains, saved.preferred, order.order, lifecycle],
  );
  const active = threads.find((t) => t.id === activeThreadId);
  const selectedGroup = active ? worktreeKey(active) : null;
  // Selection always wins over an older manual expansion, including external navigation.
  const expanded =
    expansion.selection === activeThreadId ? expansion.group : selectedGroup;
  const anchorSelection = useSelectionAnchor(scroll.containerRef, expanded);
  useEffect(() => {
    setExpansion({ selection: activeThreadId, group: selectedGroup });
  }, [activeThreadId, selectedGroup]);
  const previousSelection = useRef(activeThreadId);
  useEffect(() => {
    if (previousSelection.current !== activeThreadId) {
      if (active && scope !== "all" && scope !== active.projectId)
        setScope(active.projectId);
      previousSelection.current = activeThreadId;
    }
  }, [activeThreadId, active, scope]);
  const saving = useRef(new Set<string>());
  useEffect(() => {
    if (saved.status !== "ready") return;
    for (const group of groups) {
      if (!group.worktree || saved.mains.get(group.id) === group.main.id)
        continue;
      const key = group.id + group.main.id;
      if (saving.current.has(key)) continue;
      saving.current.add(key);
      if (saved.mains.has(group.id))
        toast.info(`Main thread changed to ${threadDisplayTitle(group.main)}.`);
      void saved.saveMain(group, group.main.id);
    }
  }, [groups, saved]);
  const sorted = useMemo(() => {
    // Before a group has its own rank, use the first saved member rank.
    const ranks = new Map(saved.order);
    for (const g of groups)
      if (!ranks.has(g.id)) {
        const legacy = g.members.flatMap((t) =>
          order.order.has(t.id) ? [order.order.get(t.id)!] : [],
        );
        if (legacy.length) ranks.set(g.id, Math.min(...legacy));
      }
    return sortByManualOrder(groups, ranks).sort(
      (a, b) => Number(b.pinned) - Number(a.pinned),
    );
  }, [groups, saved.order, order.order]);
  const visible = sorted.filter(
    (g) =>
      (scope === "all" || g.main.projectId === scope) &&
      (!searchQuery.trim() ||
        g.members.some((t) =>
          threadDisplayTitle(t)
            .toLowerCase()
            .includes(searchQuery.toLowerCase()),
        )),
  );
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const toggle = (key: string) =>
    setOpenShelves((s) => ({ ...s, [key]: !s[key] }));
  const peers = (
    group: ThreadGroup,
    thread: PluginSidebarThread,
    isMain: boolean,
  ) =>
    isMain
      ? sorted
          .filter(
            (g) =>
              g.pinned === group.pinned &&
              g.shelf === group.shelf &&
              (group.worktree ||
                (!g.worktree &&
                  g.main.parentThreadId === thread.parentThreadId)),
          )
          .map((g) => g.id)
      : group.members
          .filter(
            (t) => t.id !== group.main.id && t.isPinned === thread.isPinned,
          )
          .map((t) => t.id);
  const move = (
    group: ThreadGroup,
    thread: PluginSidebarThread,
    isMain: boolean,
    target: string,
    after: boolean,
  ) => {
    const next = moveRelative(
      peers(group, thread, isMain),
      isMain ? group.id : thread.id,
      target,
      after,
    );
    if (!next) return;
    if (isMain) void saved.saveOrder(next);
    else order.save(next);
    setAnnouncement(
      `${threadDisplayTitle(thread)} moved ${after ? "after" : "before"} ${isMain ? threadDisplayTitle(groups.find((g) => g.id === target)!.main) : threadDisplayTitle(threads.find((t) => t.id === target)!)}.`,
    );
  };
  const row = (
    group: ThreadGroup,
    thread: PluginSidebarThread,
    isMain: boolean,
  ) => {
    const shelf = lifecycle.shelfFor(thread);
    const rowKey = isMain ? group.id : thread.id;
    return (
      <ThreadCard
        key={thread.id}
        thread={thread}
        projectName={projectNames.get(thread.projectId) ?? null}
        isActive={activeThreadId === thread.id}
        compact={!isMain}
        now={now}
        canPark={lifecycle.canPark(thread)}
        shelf={shelf}
        wakeAt={lifecycle.wakeAtFor(thread)}
        onRestore={() =>
          shelf === "snoozed"
            ? lifecycle.unsnooze(thread.id)
            : lifecycle.unsettle(thread.id)
        }
        onNavigate={onNavigate}
        onSelect={() => {
          anchorSelection(thread.id, group.worktree ? group.id : null);
          setExpansion({
            selection: thread.id,
            group: group.worktree ? group.id : null,
          });
        }}
        onSettle={() => lifecycle.settle(thread.id, isMain && group.worktree)}
        onSnooze={(until) => lifecycle.snooze(thread.id, until)}
        onMakeMain={
          group.worktree && !isMain
            ? () => void saved.saveMain(group, thread.id)
            : undefined
        }
        group={
          isMain && group.worktree
            ? {
                count: group.members.length,
                canSettle:
                  group.shelf !== "settled" &&
                  group.members.every(lifecycle.canPark),
                expanded: expanded === group.id,
                toggle: () => {
                  anchorSelection(
                    thread.id,
                    expanded === group.id ? null : group.id,
                  );
                  setExpansion({
                    selection: activeThreadId,
                    group: expanded === group.id ? null : group.id,
                  });
                },
                summary: groupAttentionItems(group.members),
                selectedChild:
                  active &&
                  active.id !== thread.id &&
                  group.members.some((t) => t.id === active.id)
                    ? threadDisplayTitle(active)
                    : null,
              }
            : undefined
        }
        isDragging={drag?.threadId === thread.id}
        dropPlacement={drop?.id === rowKey ? drop.placement : null}
        onDragStart={(event) => {
          scroll.start();
          setDrag({ threadId: thread.id, groupId: group.id, main: isMain });
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", thread.id);
        }}
        onDragOver={(event) => {
          if (
            !drag ||
            drag.main !== isMain ||
            (!isMain && drag.groupId !== group.id)
          )
            return;
          const sourceGroup = groups.find((g) => g.id === drag.groupId)!;
          const source = sourceGroup.members.find(
            (t) => t.id === drag.threadId,
          )!;
          if (!peers(sourceGroup, source, isMain).includes(rowKey)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          setDrop({
            id: rowKey,
            placement:
              event.clientY < rect.top + rect.height / 2 ? "before" : "after",
          });
        }}
        onDrop={(event) => {
          event.preventDefault();
          scroll.stop();
          if (drag && drop?.id === rowKey) {
            const sourceGroup = groups.find((g) => g.id === drag.groupId)!;
            const source = sourceGroup.members.find(
              (t) => t.id === drag.threadId,
            )!;
            move(
              sourceGroup,
              source,
              drag.main,
              rowKey,
              drop.placement === "after",
            );
          }
          setDrag(null);
          setDrop(null);
        }}
        onDragEnd={() => {
          scroll.stop();
          setDrag(null);
          setDrop(null);
        }}
        onMove={(direction) => {
          const ids = peers(group, thread, isMain);
          const target = ids[ids.indexOf(rowKey) + direction];
          if (target) move(group, thread, isMain, target, direction > 0);
        }}
      />
    );
  };
  const groupRows = (group: ThreadGroup) => {
    const children = group.members.filter((t) => t.id !== group.main.id);
    return (
      <Fragment key={group.id}>
        {row(group, group.main, true)}
        {expanded === group.id && (
          <>
            {children
              .filter(
                (t) =>
                  lifecycle.shelfFor(t) === "active" || t.id === activeThreadId,
              )
              .map((t) => row(group, t, false))}
            {(["snoozed", "settled"] as const).map((shelf) => {
              const parked = children.filter(
                (t) =>
                  lifecycle.shelfFor(t) === shelf && t.id !== activeThreadId,
              );
              const key = group.id + shelf;
              return (
                parked.length > 0 && (
                  <li key={key} className="ml-7 list-none">
                    <ShelfButton
                      label={shelf === "snoozed" ? "Snoozed" : "Settled"}
                      count={parked.length}
                      open={!!openShelves[key]}
                      toggle={() => toggle(key)}
                    />
                    {openShelves[key] && (
                      <ul>{parked.map((t) => row(group, t, false))}</ul>
                    )}
                  </li>
                )
              );
            })}
          </>
        )}
      </Fragment>
    );
  };
  if (
    status === "error" ||
    saved.status === "error" ||
    lifecycle.status === "error" ||
    order.status === "error"
  )
    return (
      <>
        <p role="alert" className="px-3 py-2 text-xs">
          Could not load Treelanes. Showing BB's list.
        </p>
        <Original />
      </>
    );
  const ready =
    status === "ready" &&
    saved.status === "ready" &&
    lifecycle.status === "ready" &&
    order.status === "ready";
  const shelfGroups = (shelf: ThreadShelf) =>
    visible.filter((g) => g.shelf === shelf);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger
            className="h-7 min-w-0 flex-1 border-0 px-1.5 py-1 text-xs font-medium text-muted-foreground shadow-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
            aria-label={`Project scope: ${scope === "all" ? "All projects" : projectNames.get(scope)}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div
        ref={scroll.containerRef}
        data-testid="thread-scroll-area"
        onDragOver={scroll.onDragOver}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] px-2 pb-4"
      >
        {!ready ? (
          <div role="status" className="space-y-3 px-2 py-3">
            <span className="sr-only">Loading threads…</span>
            {[0, 1, 2, 3].map((key) => (
              <div
                key={key}
                aria-hidden="true"
                className="space-y-2 rounded-lg py-2"
              >
                <div className="h-4 w-4/5 rounded bg-sidebar-accent" />
                <div className="h-3 w-3/5 rounded bg-sidebar-accent" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-8 text-sm">
            <p className="font-medium">
              {searchQuery ? "No threads found" : "No threads yet"}
            </p>
            <p className="mt-2 text-pretty text-muted-foreground">
              {searchQuery
                ? "Try a shorter search or select All projects."
                : "Select New thread to start."}
            </p>
          </div>
        ) : (
          <>
            {[true, false].map((pinned) => {
              const gs = shelfGroups("active").filter(
                (g) => g.pinned === pinned,
              );
              return (
                gs.length > 0 && (
                  <section
                    key={String(pinned)}
                    aria-label={pinned ? "Pinned" : "Inbox"}
                  >
                    {pinned && (
                      <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                        Pinned
                      </p>
                    )}
                    <ul>{gs.map(groupRows)}</ul>
                  </section>
                )
              );
            })}
            {(["snoozed", "settled"] as const).map((shelf) => {
              const gs = shelfGroups(shelf);
              const selected = gs.some((g) =>
                g.members.some((t) => t.id === activeThreadId),
              );
              const open = !!openShelves[shelf] || selected;
              return (
                gs.length > 0 && (
                  <section
                    key={shelf}
                    aria-label={shelf === "snoozed" ? "Snoozed" : "Settled"}
                  >
                    <ShelfButton
                      label={shelf === "snoozed" ? "Snoozed" : "Settled"}
                      count={gs.length}
                      open={open}
                      toggle={() => toggle(shelf)}
                    />
                    {open && <ul>{gs.map(groupRows)}</ul>}
                  </section>
                )
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
function ShelfButton({
  label,
  count,
  open,
  toggle,
}: {
  label: string;
  count: number;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      className="mt-2 flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium pointer-coarse:min-h-11 text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon
        name="ChevronDown"
        aria-hidden="true"
        className={cn("size-4", !open && "-rotate-90")}
      />
      {label} ({count})
    </button>
  );
}
