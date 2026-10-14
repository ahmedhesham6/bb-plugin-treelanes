import { useEffect, useRef } from "react";

/** A fixed green dot with a slow pulse; stop work when it is out of view. */
export function RunningDot() {
  const pulse = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = pulse.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    const sync = () => {
      element.style.animationPlayState =
        visible && !document.hidden ? "running" : "paused";
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return (
    <span
      aria-hidden="true"
      data-running-dot=""
      className="relative inline-flex size-2 shrink-0"
    >
      <span
        ref={pulse}
        className="absolute -inset-1 rounded-full bg-green-600/20 motion-safe:animate-pulse dark:bg-green-400/20"
      />
      <span className="relative size-2 rounded-full bg-green-600 dark:bg-green-400" />
    </span>
  );
}
