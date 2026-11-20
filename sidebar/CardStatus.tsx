import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { PLUGIN_ID } from "../plugin-id";
import type { groupAttentionItems } from "./groups";
import { relativeTimeLabel } from "./relative-time";

type AttentionItem = ReturnType<typeof groupAttentionItems>[number];

const CARD_STATUS: Record<
  AttentionItem["kind"],
  { label: string; icon: string; className: string }
> = {
  input: {
    label: "Input",
    icon: "MessageQuestion",
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: {
    label: "Failed",
    icon: "AlertCircle",
    className: "text-red-700 dark:text-red-400",
  },
  running: {
    label: "Working",
    icon: `${PLUGIN_ID}/status-working`,
    className: "text-blue-700 dark:text-blue-400",
  },
  unread: {
    label: "Done",
    icon: "CircleCheck",
    className: "text-success-foreground",
  },
};

/**
 * T3 Code's status words and colors. The first summary item wins, so the
 * order of `groupAttentionItems` is the priority: Input, Failed, Working, Done.
 */
export function CardStatusOrTime({
  summary,
  updatedAt,
  now,
}: {
  summary: readonly AttentionItem[];
  updatedAt: number;
  now: number;
}) {
  const top = summary[0];
  if (!top) return <span>{relativeTimeLabel(updatedAt, now)}</span>;
  const status = CARD_STATUS[top.kind];
  return (
    <span
      aria-hidden="true"
      data-status={top.kind}
      className={cn("inline-flex items-center gap-1 font-medium", status.className)}
    >
      <Icon name={status.icon} aria-hidden="true" className="size-4 shrink-0" />
      {top.count > 1
        ? `${top.count} ${status.label.toLowerCase()}`
        : status.label}
    </span>
  );
}
