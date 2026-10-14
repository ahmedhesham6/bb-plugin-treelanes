import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedSkills } from "./test-workspace";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("shipped skills", () => {
  it("names each skill after its folder", () => {
    for (const skill of shippedSkills)
      expect(read(`./skills/${skill}/SKILL.md`).match(/^---\n[\s\S]*?^name: (\S+)$/m)?.[1]).toBe(skill);
  });

  it("lists exactly the shipped skills in SOURCES.md", () => {
    const listed = [...read("./skills/SOURCES.md").matchAll(/^\| ([a-z][a-z-]*) \|/gm)].map(match => match[1]);
    expect(listed.sort()).toEqual(shippedSkills);
  });
});
