// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ProjectChip, projectIdentity } from "./ProjectChip";

afterEach(cleanup);

describe("projectIdentity", () => {
  it.each([
    ["bb", "BB", "yellow"],
    ["bb-plugin-treelanes", "BT", "orange"],
    ["Treelanes", "TS", "fuchsia"],
    ["t3code", "T3", "teal"],
    ["web 2", "W2", "sky"],
    ["Ünïcode app", "ÜA", "amber"],
    ["a", "AA", "emerald"],
    ["   ", "PR", "fuchsia"],
  ])("gives %j the initials %s and the color %s", (name, monogram, color) => {
    expect(projectIdentity(name)).toEqual({ monogram, color });
  });

  it("gives the same name the same chip after Unicode normalization and trimming", () => {
    expect(projectIdentity("ｂｂ")).toEqual(projectIdentity("bb"));
    expect(projectIdentity("  Treelanes ")).toEqual(projectIdentity("Treelanes"));
  });
});

describe("ProjectChip", () => {
  it("draws the initials in the project color on a tinted square", () => {
    const { container } = render(<ProjectChip name="bb" />);
    const chip = container.querySelector("[data-project-chip]")!;
    expect(chip.getAttribute("aria-hidden")).toBe("true");
    expect(chip.getAttribute("class")).toContain("size-4");
    const svg = chip.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-yellow-600");
    expect(svg.getAttribute("class")).toContain("dark:text-yellow-400");
    expect(svg.getAttribute("class")).toContain("rounded-[25%]");
    expect(chip.textContent).toBe("BB");
  });
});
