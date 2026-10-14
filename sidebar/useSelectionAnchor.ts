import { useLayoutEffect, useRef, type RefObject } from "react";

/** Keep the clicked row in place when an accordion above it closes. */
export function useSelectionAnchor(
  container: RefObject<HTMLDivElement | null>,
  expanded: string | null,
) {
  const pending = useRef<{
    id: string;
    top: number;
    expected: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    const anchor = pending.current;
    pending.current = null;
    if (!root || !anchor || anchor.expected !== expanded) return;
    const row = Array.from(
      root.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"),
    ).find((e) => e.dataset.sidebarThreadId === anchor.id);
    if (row) root.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }, [container, expanded]);
  return (id: string, expected: string | null) => {
    if (expected === expanded) {
      pending.current = null;
      return;
    }
    const root = container.current;
    const row =
      root &&
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"),
      ).find((e) => e.dataset.sidebarThreadId === id);
    if (row)
      pending.current = { id, top: row.getBoundingClientRect().top, expected };
  };
}
