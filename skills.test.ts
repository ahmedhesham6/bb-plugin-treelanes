import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("syncs from retained BB sources and leaves copies intact if a source is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-skill-sync-"));
    const put = (path: string, contents: string, mode?: number) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents, { mode });
    };
    const commit = "a".repeat(40);
    try {
      put("scripts/sync-skills.sh", read("./scripts/sync-skills.sh"));
      put("skills/SOURCES.md", `| tdd | ${join(root, "local/tdd")} | none |\n| delivery | ~/.bb/skills/delivery | none |\n`);
      put("local/tdd/SKILL.md", "New TDD source");
      put("retained/delivery/SKILL.md", "Retained delivery source");
      put("skills/tdd/SKILL.md", "Old TDD copy");
      put("skills/delivery/SKILL.md", "Old delivery copy");
      put("pstack/LICENSE", "MIT license");
      // Replace the network clone; file copies use the real rsync command.
      put("bin/git", `#!/usr/bin/env bash\nif [[ $1 == clone ]]; then cp -R "$PSTACK_FIXTURE/." "\${@: -1}"; else echo ${commit}; fi\n`, 0o755);
      const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PSTACK_FIXTURE: join(root, "pstack") };
      const sync = (...args: string[]) => execFileSync("bash", [join(root, "scripts/sync-skills.sh"), ...args], { env, stdio: "pipe" });
      expect(() => sync(join(root, "missing"))).toThrow(/Missing source/);
      expect(readFileSync(join(root, "skills/tdd/SKILL.md"), "utf8")).toBe("Old TDD copy");
      expect(readFileSync(join(root, "skills/delivery/SKILL.md"), "utf8")).toBe("Old delivery copy");
      sync(join(root, "retained"));
      expect(readFileSync(join(root, "skills/tdd/SKILL.md"), "utf8")).toBe("New TDD source");
      expect(readFileSync(join(root, "skills/delivery/SKILL.md"), "utf8")).toBe("Retained delivery source");
      expect(readFileSync(join(root, "skills/pstack-LICENSE"), "utf8")).toBe("MIT license");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
