// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MiddleTruncate, splitForMiddleTruncate } from "./MiddleTruncate";

afterEach(cleanup);

describe("splitForMiddleTruncate", () => {
  it("keeps a short last path segment whole", () => {
    expect(splitForMiddleTruncate("feature/ui-polish")).toEqual({
      head: "feature/",
      tail: "ui-polish",
    });
  });

  it("starts a long segment's tail on a word, not mid-word", () => {
    expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine")?.tail).toBe(
      "machine",
    );
  });

  it("keeps the fixed tail when no word break is near", () => {
    expect(splitForMiddleTruncate("t3/abcdefghijklmnopqrstuvwxyz")?.tail).toBe(
      "qrstuvwxyz",
    );
  });

  it("does not split a short value", () => {
    expect(splitForMiddleTruncate("same-branch")).toBeNull();
  });
});

describe("MiddleTruncate", () => {
  it("cuts the head and keeps the tail of a long branch", () => {
    const { container } = render(
      <MiddleTruncate value="ahmed/clone-repo-to-other-machine" />,
    );
    const root = container.firstElementChild!;
    expect(root.getAttribute("title")).toBe("ahmed/clone-repo-to-other-machine");
    const [head, tail] = Array.from(root.children);
    expect(head!.textContent).toBe("ahmed/clone-repo-to-other-");
    expect(head!.className).toContain("truncate");
    expect(tail!.textContent).toBe("machine");
    expect(tail!.className).toContain("shrink-0");
  });

  it("collapses runs of spaces so the cut keeps one space", () => {
    const { container } = render(<MiddleTruncate value="Sawyer's  MacBook Pro" />);
    expect(container.textContent).toBe("Sawyer's MacBook Pro");
  });
});
