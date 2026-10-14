import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ThreadChat,
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  BoardResult,
  ComposerDefaultsResult,
  rpcContract,
} from "./server";
import type { StageId } from "./workflow";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";
import { ThreadInbox } from "./sidebar/ThreadInbox";
import { ParentChip } from "./sidebar/ParentChip";
import { SubagentsChip } from "./sidebar/SubagentsChip";

type Card = BoardResult["cards"][number];
type Stage = BoardResult["stages"][number];
type ViewFilter = "all" | "active" | "attention";

const IMPLEMENTATION_STAGE_IDS: StageId[] = ["tdd", "quality", "simplify"];
const STAGE_ORDER: StageId[] = [
  "tickets",
  "design",
  "tdd",
  "quality",
  "simplify",
  "pr",
  "done",
];

const GIT_DIFF_TAB_ID = "git-diff:git-diff:none";

function requestBuiltInDiffPanel(threadId: string): void {
  if (typeof window === "undefined") return;

  const key = `bb.thread.fixedPanelTabsState-${encodeURIComponent(threadId.trim())}-1`;
  let stored: Record<string, unknown> = {};
  let tabs: unknown[] = [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stored = parsed as Record<string, unknown>;
      const secondary = stored.secondary;
      if (secondary && typeof secondary === "object" && !Array.isArray(secondary)) {
        const storedTabs = (secondary as { tabs?: unknown }).tabs;
        if (Array.isArray(storedTabs)) tabs = storedTabs;
      }
    }
  } catch {
    // Replace invalid saved panel data with a valid diff panel state.
  }

  const tabsWithoutDiff = tabs.filter(
    (tab) =>
      !(
        tab &&
        typeof tab === "object" &&
        (tab as { kind?: unknown }).kind === "git-diff"
      ),
  );

  window.localStorage.setItem(
    key,
    JSON.stringify({
      ...stored,
      version: 1,
      secondary: {
        tabs: [...tabsWithoutDiff, { id: GIT_DIFF_TAB_ID, kind: "git-diff" }],
        activeTabId: GIT_DIFF_TAB_ID,
        isOpen: true,
      },
      lastUsedAt: Date.now(),
    }),
  );
}

const STAGE_ICONS: Record<StageId, React.ComponentProps<typeof Icon>["name"]> =
  {
    tickets: "CircleDashed",
    design: "Idea",
    tdd: "Beaker",
    quality: "CircleCheck",
    simplify: "Clean",
    review: "Search",
    pr: "GitPullRequest",
    done: "Check",
  };

function statusText(status: Card["status"]): string {
  if (status === "active") return "Agent running";
  if (status === "pending") return "Agent queued";
  if (status === "starting") return "Agent starting";
  if (status === "stopping") return "Agent stopping";
  if (status === "error") return "Needs attention";
  return "Idle";
}

function statusClass(status: Card["status"]): string {
  if (status === "active" || status === "pending" || status === "starting")
    return "bg-primary";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground";
}

function cardHasLiveWork(card: Card): boolean {
  return (
    card.status === "active" ||
    card.status === "pending" ||
    card.status === "starting" ||
    card.status === "stopping" ||
    card.threads.some((thread) =>
      ["active", "pending", "starting", "stopping"].includes(thread.status),
    )
  );
}

function cardNeedsAttention(card: Card): boolean {
  return (
    card.hasPendingInteraction ||
    card.status === "error" ||
    card.threads.some(
      (thread) => thread.status === "error" || thread.hasPendingInteraction,
    )
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function BoardSkeleton() {
  return (
    <div
      className="flex h-full gap-3 overflow-hidden p-3 md:p-4"
      aria-label="Loading board"
    >
      {Array.from({ length: 4 }, (_, column) => (
        <div
          key={column}
          className={cn(
            "w-full min-w-0 rounded-lg border border-border bg-muted/20 p-3 md:w-72 md:min-w-72",
            column > 0 && "hidden md:block",
          )}
        >
          <div className="mb-3 h-5 w-24 rounded bg-muted" />
          {Array.from({ length: 3 }, (_, card) => (
            <div
              key={card}
              className="mb-2.5 h-32 rounded-lg border border-border bg-card"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyBoard({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-lg border border-border bg-muted/30">
          <Icon
            name="GitBranch"
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <h2 className="text-balance text-base font-semibold text-foreground">
          No unsettled worktrees
        </h2>
        <p className="mt-1.5 text-pretty text-sm leading-5 text-muted-foreground">
          A Git worktree appears here when it has at least one unsettled thread.
        </p>
        <Button className="mt-4 h-10" onClick={onCreate}>
          <Icon name="Plus" aria-hidden="true" />
          New work
        </Button>
      </div>
    </div>
  );
}

function WorkCard({
  card,
  saving,
  error,
  selected,
  showProject,
  onOpen,
  onSettle,
  onNewThread,
  onReview,
  onStartThread,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  saving: boolean;
  error: string | null;
  selected: boolean;
  showProject: boolean;
  onOpen: (threadId: string) => void;
  onSettle: (threadId: string) => Promise<void>;
  onNewThread: (card: Card) => void;
  onReview: (card: Card) => void;
  onStartThread: (card: Card) => void;
  onDragStart: (environmentId: string) => void;
  onDragEnd: () => void;
}) {
  const liveWork = cardHasLiveWork(card);
  const needsAttention = cardNeedsAttention(card);
  const pendingSettles = useRef(new Set<string>());
  const [settling, setSettling] = useState(() => new Set<string>());
  const [settleError, setSettleError] = useState<string | null>(null);

  async function settle(threadId: string) {
    if (pendingSettles.current.has(threadId)) return;
    pendingSettles.current.add(threadId);
    setSettling(new Set(pendingSettles.current));
    setSettleError(null);
    try {
      await onSettle(threadId);
    } catch (error) {
      setSettleError(error instanceof Error ? error.message : "Could not settle the thread.");
    } finally {
      pendingSettles.current.delete(threadId);
      setSettling(new Set(pendingSettles.current));
    }
  }

  return (
    <article
      draggable={!saving}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button")) {
          onOpen(card.threads[0]!.id);
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.environmentId);
        onDragStart(card.environmentId);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative cursor-pointer rounded-lg border bg-card p-3 shadow-sm transition-colors hover:border-foreground/25 focus-within:border-foreground/30",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border",
        saving && "opacity-60",
      )}
      aria-current={selected ? "true" : undefined}
    >
      <div className="relative z-10">
        <div className="mb-3 flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => onOpen(card.threads[0]!.id)}
            className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open ${card.worktreeName}`}
          >
            <span className="flex items-center gap-2">
              <Icon
                name="GitBranch"
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="line-clamp-2 text-pretty text-sm font-semibold text-foreground">
                {card.worktreeName}
              </span>
            </span>
            {card.branchName && card.branchName !== card.worktreeName ? (
              <span className="mt-1 block truncate pl-6 font-mono text-xs text-muted-foreground">
                {card.branchName}
              </span>
            ) : null}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              className="size-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => onReview(card)}
              aria-label={`Review changes in ${card.worktreeName}`}
            >
              <Icon name="FileDiff" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => onNewThread(card)}
              aria-label={`New thread in ${card.worktreeName}`}
            >
              <Icon name="MessageCirclePlus" aria-hidden="true" />
            </Button>
            <Icon
              name="DragDropVertical"
              className="size-4 shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </div>
        </div>

        {card.note ? (
          <p className="mb-3 line-clamp-2 text-pretty text-xs leading-5 text-muted-foreground">
            {card.note}
          </p>
        ) : null}

        {card.pendingThreadStart ? (
          <Button
            type="button"
            variant="outline"
            className="mb-3 h-8 w-full justify-start px-2.5 text-xs"
            disabled={saving}
            onClick={() => onStartThread(card)}
            aria-label={`${card.pendingThreadStart.label} in ${card.worktreeName}`}
          >
            <Icon name="Play" aria-hidden="true" />
            {card.pendingThreadStart.label}
          </Button>
        ) : null}

        <div className="mb-3 overflow-hidden rounded-md border border-border bg-muted/30">
          <div className="flex min-h-8 items-center justify-between border-b border-border px-2 text-xs font-medium text-muted-foreground">
            <span>Unsettled threads</span>
            <span className="min-w-5 rounded bg-muted px-1 text-center tabular-nums">
              {card.threads.length}
            </span>
          </div>
          <div className="divide-y divide-border/70">
            {card.threads.map((thread) => (
              <div key={thread.id} className="flex min-w-0 items-center">
                <button
                  type="button"
                  onClick={() => onOpen(thread.id)}
                  className={cn(
                    "group/thread flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    thread.parentThreadId && "pl-5",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      thread.hasPendingInteraction
                        ? "bg-destructive"
                        : statusClass(thread.status),
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  {thread.hasPendingInteraction ? (
                    <Icon
                      name="AlertCircle"
                      className="size-3.5 shrink-0 text-destructive"
                      aria-label="Waiting for you"
                    />
                  ) : null}
                  <Icon
                    name="ArrowUpRight"
                    className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/thread:opacity-70 group-focus-within/thread:opacity-70"
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  aria-label={`Settle ${thread.title}`}
                  aria-busy={settling.has(thread.id)}
                  title={
                    settling.has(thread.id)
                      ? "Settling thread…"
                      : thread.canSettle
                        ? "Settle thread"
                        : "Wait for live work and pending questions to finish"
                  }
                  disabled={saving || !thread.canSettle || settling.has(thread.id)}
                  className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={(event) => {
                    event.stopPropagation();
                    void settle(thread.id);
                  }}
                >
                  <Icon
                    name={settling.has(thread.id) ? "Loading" : "CircleCheck"}
                    className="size-4"
                    aria-hidden="true"
                  />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs leading-4 text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                needsAttention ? "bg-destructive" : statusClass(card.status),
              )}
              aria-hidden="true"
            />
            <span
              className={cn("truncate", needsAttention && "text-destructive")}
            >
              {card.hasPendingInteraction
                ? "Waiting for you"
                : needsAttention
                  ? "Needs attention"
                  : liveWork
                    ? "In progress"
                    : statusText(card.status)}
            </span>
          </span>
          <span className="min-w-0 truncate text-right tabular-nums">
            {relativeTime(card.updatedAt)}
            {showProject ? ` · ${card.projectName}` : ""}
          </span>
        </div>

        {settleError || error ? (
          <p role="alert" className="mt-2 text-pretty text-xs text-destructive">
            {settleError || error}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function CardStack({
  cards,
  emptyText,
  saving,
  cardErrors,
  selectedThreadId,
  showProject,
  onOpen,
  onSettle,
  onNewThread,
  onReview,
  onStartThread,
  onDragStart,
  onDragEnd,
}: {
  cards: Card[];
  emptyText: string;
  saving: Set<string>;
  cardErrors: Record<string, string>;
  selectedThreadId: string | null;
  showProject: boolean;
  onOpen: (threadId: string) => void;
  onSettle: (threadId: string) => Promise<void>;
  onNewThread: (card: Card) => void;
  onReview: (card: Card) => void;
  onStartThread: (card: Card) => void;
  onDragStart: (environmentId: string) => void;
  onDragEnd: () => void;
}) {
  if (cards.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-5 text-center">
        <p className="text-pretty text-xs text-muted-foreground">{emptyText}</p>
      </div>
    );
  }

  return cards.map((card) => (
    <WorkCard
      key={card.environmentId}
      card={card}
      saving={saving.has(card.environmentId)}
      error={cardErrors[card.environmentId] || null}
      selected={card.threads.some((thread) => thread.id === selectedThreadId)}
      showProject={showProject}
      onOpen={onOpen}
      onSettle={onSettle}
      onNewThread={onNewThread}
      onReview={onReview}
      onStartThread={onStartThread}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />
  ));
}

function StageColumn({
  stage,
  cards,
  emptyText,
  isDropTarget,
  saving,
  cardErrors,
  selectedThreadId,
  showProject,
  onOpen,
  onSettle,
  onNewThread,
  onReview,
  onStartThread,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  stage: Stage;
  cards: Card[];
  emptyText: string;
  isDropTarget: boolean;
  saving: Set<string>;
  cardErrors: Record<string, string>;
  selectedThreadId: string | null;
  showProject: boolean;
  onOpen: (threadId: string) => void;
  onSettle: (threadId: string) => Promise<void>;
  onNewThread: (card: Card) => void;
  onReview: (card: Card) => void;
  onStartThread: (card: Card) => void;
  onDragStart: (environmentId: string) => void;
  onDragEnd: () => void;
  onDragOver: React.DragEventHandler<HTMLElement>;
  onDragLeave: React.DragEventHandler<HTMLElement>;
  onDrop: React.DragEventHandler<HTMLElement>;
}) {
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex h-full w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-muted/20 md:w-72 md:min-w-72 md:flex-none",
        isDropTarget ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <header className="flex min-h-11 items-center border-b border-border px-3">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon
              name={STAGE_ICONS[stage.id]}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="truncate text-balance text-sm font-semibold text-foreground">
              {stage.label}
            </h2>
          </div>
          <span className="min-w-6 rounded-md bg-muted px-1.5 py-0.5 text-center text-xs tabular-nums text-muted-foreground">
            {cards.length}
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
        <CardStack
          cards={cards}
          emptyText={emptyText}
          saving={saving}
          cardErrors={cardErrors}
          selectedThreadId={selectedThreadId}
          showProject={showProject}
          onOpen={onOpen}
          onSettle={onSettle}
          onNewThread={onNewThread}
          onReview={onReview}
          onStartThread={onStartThread}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      </div>
    </section>
  );
}

function TreelanesBoard({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [board, setBoard] = useState<BoardResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Set<string>>(() => new Set());
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<StageId | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [composerDefaults, setComposerDefaults] =
    useState<ComposerDefaultsResult | null>(null);
  const [composerDefaultsError, setComposerDefaultsError] = useState<
    string | null
  >(null);
  const [composerDefaultsRequest, setComposerDefaultsRequest] = useState(0);
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState<ViewFilter>("all");
  const deferredSearch = useDeferredValue(search);
  const hasConnected = useRef(false);
  const newThreadEnvironmentId = subPath.startsWith("new-thread/")
    ? decodeURIComponent(subPath.slice("new-thread/".length))
    : null;
  const newThreadCard = useMemo(
    () =>
      newThreadEnvironmentId
        ? (board?.cards.find(
            (card) => card.environmentId === newThreadEnvironmentId,
          ) ?? null)
        : null,
    [board, newThreadEnvironmentId],
  );
  const defaultsThreadId = newThreadCard?.threads[0]?.id ?? null;
  const load = useCallback(async () => {
    try {
      const result = await rpc.call("getBoard", { projectId });
      setBoard(result);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not load the board.",
      );
    }
  }, [projectId, rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (connection !== "connected") return;
    if (hasConnected.current) void load();
    hasConnected.current = true;
  }, [connection, load]);

  useRealtime("board-changed", () => {
    void load();
  });

  useEffect(() => {
    if (!defaultsThreadId) {
      setComposerDefaults(null);
      setComposerDefaultsError(null);
      return;
    }
    let cancelled = false;
    setComposerDefaults(null);
    setComposerDefaultsError(null);
    void rpc
      .call("getComposerDefaults", { threadId: defaultsThreadId })
      .then((result) => {
        if (!cancelled) setComposerDefaults(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setComposerDefaultsError(
            error instanceof Error
              ? error.message
              : "Could not load the thread settings.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composerDefaultsRequest, defaultsThreadId, rpc]);

  const reviewChanges = useCallback(
    (card: Card) => {
      const thread = card.threads.reduce<Card["threads"][number] | null>(
        (latest, candidate) =>
          latest === null || candidate.updatedAt > latest.updatedAt
            ? candidate
            : latest,
        null,
      );
      if (!thread) return;
      requestBuiltInDiffPanel(thread.id);
      navigate.toThread(thread.id);
    },
    [navigate],
  );

  const openThread = useCallback((threadId: string) => {
    setOpenThreadId(threadId);
  }, []);

  const settleThread = useCallback(async (threadId: string) => {
    await rpc.call("settleThread", { threadId });
    setOpenThreadId((current) => current === threadId ? null : current);
    await load();
  }, [load, rpc]);

  const moveCard = useCallback(
    async (environmentId: string, stage: StageId) => {
      if (!board) return;
      const oldStage = board.cards.find(
        (card) => card.environmentId === environmentId,
      )?.stage;
      if (!oldStage || oldStage === stage) return;
      setBoard({
        ...board,
        cards: board.cards.map((card) =>
          card.environmentId === environmentId ? { ...card, stage } : card,
        ),
      });
      setSaving((current) => new Set(current).add(environmentId));
      setCardErrors((current) => ({ ...current, [environmentId]: "" }));
      try {
        await rpc.call("moveCard", { environmentId, stage });
      } catch (error) {
        setBoard((current) =>
          current
            ? {
                ...current,
                cards: current.cards.map((card) =>
                  card.environmentId === environmentId
                    ? { ...card, stage: oldStage }
                    : card,
                ),
              }
            : current,
        );
        setCardErrors((current) => ({
          ...current,
          [environmentId]:
            error instanceof Error
              ? error.message
              : "Could not move this card.",
        }));
      } finally {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(environmentId);
          return next;
        });
      }
    },
    [board, rpc],
  );

  const startOfferedThread = useCallback(
    async (card: Card) => {
      setSaving((current) => new Set(current).add(card.environmentId));
      setCardErrors((current) => ({ ...current, [card.environmentId]: "" }));
      try {
        const result = await rpc.call("startStageThread", {
          environmentId: card.environmentId,
        });
        await load();
        navigate.toThread(result.threadId);
      } catch (error) {
        setCardErrors((current) => ({
          ...current,
          [card.environmentId]:
            error instanceof Error
              ? error.message
              : "Could not start this stage thread.",
        }));
      } finally {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(card.environmentId);
          return next;
        });
      }
    },
    [load, navigate, rpc],
  );

  const filteredCards = useMemo(() => {
    const query = deferredSearch.trim().toLocaleLowerCase();
    return (board?.cards ?? []).filter((card) => {
      if (viewFilter === "active" && !cardHasLiveWork(card)) return false;
      if (viewFilter === "attention" && !cardNeedsAttention(card)) return false;
      if (!query) return true;
      return [
        card.worktreeName,
        card.branchName ?? "",
        card.note ?? "",
        card.projectName,
        ...card.threads.map((thread) => thread.title),
      ].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [board, deferredSearch, viewFilter]);

  const cardsByStage = useMemo(() => {
    const groups = new Map<StageId, Card[]>();
    for (const stage of board?.stages ?? []) groups.set(stage.id, []);
    for (const card of filteredCards) groups.get(card.stage)?.push(card);
    return groups;
  }, [board, filteredCards]);

  const implementationStages = useMemo(
    () =>
      board?.stages.filter((stage) =>
        IMPLEMENTATION_STAGE_IDS.includes(stage.id),
      ) ?? [],
    [board],
  );

  const simpleStages = useMemo(
    () =>
      board?.stages.filter(
        (stage) => !IMPLEMENTATION_STAGE_IDS.includes(stage.id),
      ) ?? [],
    [board],
  );

  const openCard = useMemo(() => {
    if (!openThreadId) return null;
    for (const card of board?.cards ?? []) {
      if (card.threads.some((item) => item.id === openThreadId)) {
        return card;
      }
    }
    return null;
  }, [board, openThreadId]);

  const openThreadTitle = useMemo(() => {
    if (!openThreadId || !openCard) return "Thread";
    return (
      openCard.threads.find((item) => item.id === openThreadId)?.title ??
      "Thread"
    );
  }, [openCard, openThreadId]);

  const openStageIndex = openCard ? STAGE_ORDER.indexOf(openCard.stage) : -1;
  const previousStage =
    openStageIndex > 0 ? STAGE_ORDER[openStageIndex - 1] : null;
  const nextStage =
    openStageIndex >= 0 && openStageIndex < STAGE_ORDER.length - 1
      ? STAGE_ORDER[openStageIndex + 1]
      : null;

  const clearDrag = useCallback(() => {
    setDraggedId(null);
    setDropStage(null);
  }, []);

  if (!board && !loadError) return <BoardSkeleton />;

  if (!board) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h2 className="text-balance text-lg font-semibold text-foreground">
            The board could not load
          </h2>
          <p className="mt-2 text-pretty text-sm text-destructive">
            {loadError}
          </p>
          <Button className="mt-4" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (newThreadEnvironmentId) {
    const card = newThreadCard;
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex min-h-16 items-center gap-3 border-b border-border px-3 py-3 md:px-5">
          <Button
            variant="ghost"
            className="size-10 shrink-0 p-0"
            onClick={() => navigate.toPluginPanel("board")}
            aria-label="Back to board"
          >
            <Icon name="ChevronLeft" aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">
              New thread
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {card
                ? `${card.worktreeName}${card.branchName ? ` · ${card.branchName}` : ""}`
                : "Git Worktree unavailable"}
            </p>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {card ? (
            <div className="mx-auto w-full max-w-4xl">
              <div className="mb-5 rounded-lg border border-border bg-muted/20 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon
                    name="GitBranch"
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{card.worktreeName}</span>
                </div>
                <p className="mt-1 pl-6 text-xs text-muted-foreground">
                  This new thread will use the same Git Worktree.
                </p>
              </div>
              {composerDefaults ? (
                <NewThreadComposer
                  defaultProjectId={card.projectId}
                  defaultProviderId={composerDefaults.providerId}
                  defaultModel={composerDefaults.model}
                  defaultServiceTier={composerDefaults.serviceTier}
                  defaultReasoningLevel={composerDefaults.reasoningLevel}
                  defaultPermissionMode={composerDefaults.permissionMode}
                  defaultEnvironment={{
                    type: "reuse",
                    environmentId: card.environmentId,
                  }}
                  placeholder={`What should the agent do in ${card.worktreeName}?`}
                  layout="document"
                  focusRequest={1}
                  draftKey={`treelanes:new-thread:${card.environmentId}`}
                  onSubmit={async (request) => {
                    const result = await rpc.call("createThread", { request });
                    navigate.toThread(result.threadId);
                  }}
                />
              ) : composerDefaultsError ? (
                <div className="rounded-lg border border-destructive/30 p-5 text-center">
                  <p role="alert" className="text-sm text-destructive">
                    {composerDefaultsError}
                  </p>
                  <Button
                    variant="outline"
                    className="mt-3"
                    onClick={() =>
                      setComposerDefaultsRequest((request) => request + 1)
                    }
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <div
                  className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
                  role="status"
                >
                  <Icon name="Spinner" className="size-4 animate-spin" aria-hidden="true" />
                  Loading thread settings
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Git Worktree not found
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  It may no longer have an Unsettled Thread on this board.
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => navigate.toPluginPanel("board")}
                >
                  Back to board
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="space-y-3 border-b border-border px-3 py-3 md:px-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {projectId ? "Current project" : "All projects"}
              </p>
              <p
                className="text-pretty text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {filteredCards.length} of {board.cards.length}{" "}
                {board.cards.length === 1 ? "worktree" : "worktrees"}
                {connection === "reconnecting" ? " · Reconnecting" : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="size-10 p-0"
                onClick={() => void load()}
                aria-label="Refresh board"
              >
                <Icon name="RotateCcw" aria-hidden="true" />
              </Button>
              <Button
                className="h-10"
                onClick={() => navigate.toCompose({ focusPrompt: true })}
              >
                <Icon name="Plus" aria-hidden="true" />
                New work
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="w-full space-y-1 sm:min-w-64 sm:flex-1 md:max-w-sm">
              <span className="text-xs font-medium text-foreground">
                Search work
              </span>
              <span className="relative block">
                <Icon
                  name="Search"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Worktrees, branches, or threads"
                  className="h-10 pl-9"
                />
              </span>
            </label>
            <div
              className="flex h-10 items-center rounded-md border border-border bg-muted/30 p-1"
              role="group"
              aria-label="Filter work"
            >
              {(
                [
                  ["all", "All"],
                  ["active", "Active"],
                  ["attention", "Attention"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  variant={viewFilter === value ? "secondary" : "ghost"}
                  className="h-8 px-3"
                  aria-pressed={viewFilter === value}
                  onClick={() => setViewFilter(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {search || viewFilter !== "all" ? (
              <Button
                variant="ghost"
                className="h-10"
                onClick={() => {
                  setSearch("");
                  setViewFilter("all");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </header>

        {loadError ? (
          <div
            role="alert"
            className="border-b border-destructive/30 px-4 py-2 text-sm text-destructive"
          >
            {loadError}
          </div>
        ) : null}

        {board.cards.length === 0 ? (
          <EmptyBoard
            onCreate={() => navigate.toCompose({ focusPrompt: true })}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
            <div className="flex min-w-0 flex-col gap-3 md:h-full md:min-w-max md:flex-row">
              {simpleStages.map((stage, index) => {
                const cards = cardsByStage.get(stage.id) ?? [];
                const isDropTarget =
                  dropStage === stage.id && draggedId !== null;
                const column = (
                  <StageColumn
                    key={stage.id}
                    stage={stage}
                    cards={cards}
                    emptyText={
                      filteredCards.length === 0 && board.cards.length > 0
                        ? "Clear filters to see work."
                        : "Drop work here."
                    }
                    isDropTarget={isDropTarget}
                    saving={saving}
                    cardErrors={cardErrors}
                    selectedThreadId={openThreadId}
                    showProject={projectId === null}
                    onOpen={openThread}
                    onSettle={settleThread}
                    onNewThread={(card) =>
                      navigate.toPluginPanel("board", {
                        subPath: `new-thread/${encodeURIComponent(card.environmentId)}`,
                      })
                    }
                    onReview={reviewChanges}
                    onStartThread={(card) => void startOfferedThread(card)}
                    onDragStart={setDraggedId}
                    onDragEnd={clearDrag}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropStage(stage.id);
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null,
                        )
                      ) {
                        setDropStage(null);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const environmentId =
                        event.dataTransfer.getData("text/plain") || draggedId;
                      setDropStage(null);
                      setDraggedId(null);
                      if (environmentId) void moveCard(environmentId, stage.id);
                    }}
                  />
                );

                if (index !== 1) return column;

                const implementationCards = implementationStages.flatMap(
                  (implementationStage) =>
                    cardsByStage.get(implementationStage.id) ?? [],
                );
                const implementationDropTarget =
                  dropStage === "tdd" && draggedId !== null;
                return (
                  <div key="design-and-implementation" className="contents">
                    {column}
                    <section
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropStage("tdd");
                      }}
                      onDragLeave={(event) => {
                        if (
                          !event.currentTarget.contains(
                            event.relatedTarget as Node | null,
                          )
                        ) {
                          setDropStage(null);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const environmentId =
                          event.dataTransfer.getData("text/plain") || draggedId;
                        setDropStage(null);
                        setDraggedId(null);
                        if (!environmentId) return;
                        const currentStage = board.cards.find(
                          (card) => card.environmentId === environmentId,
                        )?.stage;
                        if (
                          currentStage &&
                          !IMPLEMENTATION_STAGE_IDS.includes(currentStage)
                        ) {
                          void moveCard(environmentId, "tdd");
                        }
                      }}
                      className={cn(
                        "flex h-full w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-muted/10 md:w-auto md:min-w-max md:flex-none",
                        implementationDropTarget
                          ? "border-primary bg-primary/5"
                          : "border-border",
                      )}
                    >
                      <header className="flex min-h-11 items-center border-b border-border px-3">
                        <div className="flex w-full items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Icon
                              name="Code"
                              className="size-4 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <h2 className="text-balance text-sm font-semibold text-foreground">
                              Implementation
                            </h2>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>Automated</span>
                            <span className="min-w-6 rounded-md bg-muted px-1.5 py-0.5 text-center tabular-nums">
                              {implementationCards.length}
                            </span>
                          </div>
                        </div>
                      </header>
                      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-2.5 md:flex-row">
                        {implementationStages.map((implementationStage) => {
                          const stageCards =
                            cardsByStage.get(implementationStage.id) ?? [];
                          const emptyText =
                            filteredCards.length === 0 && board.cards.length > 0
                              ? "Clear filters to see work."
                              : implementationStage.id === "tdd"
                                ? "Starts after Design."
                                : implementationStage.id === "quality"
                                  ? "Starts after TDD."
                                  : "Starts after a clear review.";
                          return (
                            <div
                              key={implementationStage.id}
                              className="flex w-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted/20 md:w-72 md:min-w-72 md:flex-none"
                            >
                              <header className="flex min-h-10 items-center border-b border-border px-3">
                                <div className="flex w-full items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <Icon
                                      name={STAGE_ICONS[implementationStage.id]}
                                      className="size-4 shrink-0 text-muted-foreground"
                                      aria-hidden="true"
                                    />
                                    <h3 className="truncate text-balance text-sm font-medium text-foreground">
                                      {implementationStage.label}
                                    </h3>
                                  </div>
                                  <span className="min-w-6 rounded-md bg-muted px-1.5 py-0.5 text-center text-xs tabular-nums text-muted-foreground">
                                    {stageCards.length}
                                  </span>
                                </div>
                              </header>
                              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
                                <CardStack
                                  cards={stageCards}
                                  emptyText={emptyText}
                                  saving={saving}
                                  cardErrors={cardErrors}
                                  selectedThreadId={openThreadId}
                                  showProject={projectId === null}
                                  onOpen={openThread}
                                  onSettle={settleThread}
                                  onNewThread={(card) =>
                                    navigate.toPluginPanel("board", {
                                      subPath: `new-thread/${encodeURIComponent(card.environmentId)}`,
                                    })
                                  }
                                  onReview={reviewChanges}
                                  onStartThread={(card) =>
                                    void startOfferedThread(card)
                                  }
                                  onDragStart={setDraggedId}
                                  onDragEnd={clearDrag}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {openThreadId ? (
        <aside className="absolute inset-0 z-20 flex h-full w-full shrink-0 flex-col border-l border-border bg-background md:relative md:inset-auto md:w-96">
          <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {openThreadTitle}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {openCard
                  ? `${openCard.worktreeName} · ${
                      board.stages.find((stage) => stage.id === openCard.stage)
                        ?.label ?? "Worktree"
                    }`
                  : "Thread"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="size-10 p-0"
                onClick={() => navigate.toThread(openThreadId)}
                aria-label="Open full thread"
              >
                <Icon name="ExternalLink" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                className="size-10 p-0"
                onClick={() => setOpenThreadId(null)}
                aria-label="Close thread panel"
              >
                <Icon name="X" aria-hidden="true" />
              </Button>
            </div>
          </header>
          {openCard ? (
            <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  Move stage
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Drag the card or use these buttons.
                </p>
                {cardErrors[openCard.environmentId] ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {cardErrors[openCard.environmentId]}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="size-10 p-0"
                  disabled={
                    !previousStage || saving.has(openCard.environmentId)
                  }
                  onClick={() => {
                    if (previousStage) {
                      void moveCard(openCard.environmentId, previousStage);
                    }
                  }}
                  aria-label="Move to previous stage"
                >
                  <Icon name="ChevronLeft" aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  className="size-10 p-0"
                  disabled={!nextStage || saving.has(openCard.environmentId)}
                  onClick={() => {
                    if (nextStage)
                      void moveCard(openCard.environmentId, nextStage);
                  }}
                  aria-label="Move to next stage"
                >
                  <Icon name="ChevronRight" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <ThreadChat
              threadId={openThreadId}
              variant="compact"
              layout="contained"
              permissionPolicy="inherit"
              className="h-full"
            />
          </div>
        </aside>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Treelanes",
    icon: "Columns2",
    path: "board",
    component: TreelanesBoard,
  });
  app.slots.experimental_threadList({
    id: "inbox",
    title: "Treelanes",
    description: "One main thread per worktree. Children follow selection.",
    component: ThreadInbox,
  });
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });
});
