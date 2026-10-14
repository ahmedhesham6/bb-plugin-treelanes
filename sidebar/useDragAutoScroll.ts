import { useCallback, useEffect, useRef, type DragEvent } from "react";

const EDGE_SIZE = 56;
const MAX_SPEED = 18;

/**
 * Return the scroll distance for one animation frame.
 *
 * The speed rises as the pointer nears an edge. A pointer outside the list
 * keeps the maximum speed so a fast drag does not stop at the boundary.
 */
export function dragAutoScrollSpeed(
  pointerY: number,
  top: number,
  bottom: number,
  edgeSize = EDGE_SIZE,
  maxSpeed = MAX_SPEED,
): number {
  const height = bottom - top;
  if (height <= 0 || edgeSize <= 0 || maxSpeed <= 0) return 0;

  const edge = Math.min(edgeSize, height / 2);
  if (pointerY < top + edge) {
    const depth = Math.min(1, Math.max(0, (top + edge - pointerY) / edge));
    return -Math.ceil(maxSpeed * depth);
  }
  if (pointerY > bottom - edge) {
    const depth = Math.min(1, Math.max(0, (pointerY - (bottom - edge)) / edge));
    return Math.ceil(maxSpeed * depth);
  }
  return 0;
}

/** Keep a dragged thread moving when the pointer reaches a list edge. */
export function useDragAutoScroll() {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const speedRef = useRef(0);
  const activeRef = useRef(false);

  const start = useCallback(() => {
    activeRef.current = true;
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    speedRef.current = 0;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    if (frameRef.current !== null || speedRef.current === 0) return;

    const step = () => {
      frameRef.current = null;
      const container = containerRef.current;
      const speed = speedRef.current;
      if (!container || speed === 0) return;

      const before = container.scrollTop;
      container.scrollTop += speed;
      if (container.scrollTop !== before) {
        frameRef.current = requestAnimationFrame(step);
      }
    };

    frameRef.current = requestAnimationFrame(step);
  }, []);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!activeRef.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      speedRef.current = dragAutoScrollSpeed(
        event.clientY,
        rect.top,
        rect.bottom,
      );
      if (speedRef.current === 0) {
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        return;
      }
      schedule();
    },
    [schedule],
  );

  useEffect(() => stop, [stop]);

  return { containerRef, onDragOver, start, stop };
}
