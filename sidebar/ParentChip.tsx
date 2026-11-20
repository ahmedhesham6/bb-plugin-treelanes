import { useTitledThreads as useSidebarThreads } from "./useTitledThreads";
import {
  useBbNavigate,
  type ExperimentalThreadHeaderRowProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { Disc } from "./Disc";
import { parentOf, threadDisplayTitle } from "./inbox";

/**
 * The row under the thread header that holds one chip. The chip sits at the
 * right end, below the header actions.
 */
export const HEADER_CHIP_ROW_CLASS = "flex min-w-0 justify-end px-3 pb-1.5";

/** A chip shows no label on phone-width viewports and coarse pointers. */
export const HEADER_CHIP_LABEL_CLASS = "max-sm:hidden pointer-coarse:hidden";

/**
 * The way back out of a child thread.
 *
 * This chip names the parent and opens it. The disc repeats the parent's
 * colour from the list, so the chip points at a thread the user can recognise.
 */
export function ParentChip({ threadId }: ExperimentalThreadHeaderRowProps) {
  const { threads } = useSidebarThreads();
  const navigate = useBbNavigate();

  const parent = parentOf(threads, threadId);
  if (parent === null) return null;

  const title = threadDisplayTitle(parent);

  return (
    <div className={HEADER_CHIP_ROW_CLASS}>
      <button
        type="button"
        aria-label={`Back to parent: ${title}`}
        title={title}
        onClick={() => navigate.toThread(parent.id)}
        className={cn(
          "flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border px-2 text-2xs text-muted-foreground",
          "hover:bg-accent hover:text-foreground",
          "max-sm:px-1.5 pointer-coarse:px-1.5",
        )}
      >
        <Icon name="ChevronLeft" className="size-3 shrink-0" aria-hidden />
        <Disc thread={parent} />
        <span className={cn("truncate", HEADER_CHIP_LABEL_CLASS)}>{title}</span>
      </button>
    </div>
  );
}
