import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = readFileSync(new URL("./scripts/release.sh", import.meta.url), "utf8");

describe("release version", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
  const commit = (message: string) => git("commit", "--allow-empty", "-q", "-m", message);
  const next = () => execFileSync("bash", [join(repo, "release.sh")], {
    cwd: repo, env: { ...process.env, RELEASE_DRY_RUN: "1" }, stdio: "pipe",
  }).toString().trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "treelanes-release-"));
    writeFileSync(join(repo, "release.sh"), script);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", ".");
    commit("feat: first");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("releases the package.json version when no release tag exists", () => {
    expect(next()).toBe("v0.1.0");
  });

  it("releases nothing when only docs, chore or ci commits follow the last tag", () => {
    git("tag", "v0.1.0");
    commit("docs: explain the board");
    commit("chore(release): v0.1.0");
    commit("ci: cache npm");
    expect(next()).toBe("none");
  });

  it("bumps the patch for fix or perf, and the minor for feat", () => {
    git("tag", "v0.1.0");
    commit("fix(sidebar): keep a snoozed thread hidden");
    expect(next()).toBe("v0.1.1");
    commit("perf: cache the board");
    expect(next()).toBe("v0.1.1");
    commit("feat: add a CSV export");
    expect(next()).toBe("v0.2.0");
  });

  it("commits the new version, pushes it with its tag, and publishes notes since the last tag", () => {
    const origin = mkdtempSync(join(tmpdir(), "treelanes-origin-"));
    const bin = mkdtempSync(join(tmpdir(), "treelanes-bin-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
      git("remote", "add", "origin", origin);
      git("tag", "v0.1.0");
      commit("feat: add a CSV export");
      writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$@" > "${join(bin, "gh-args")}"\n`, { mode: 0o755 });
      execFileSync("bash", [join(repo, "release.sh")], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
      const remote = (...args: string[]) => execFileSync("git", ["--git-dir", origin, ...args]).toString().trim();
      expect(remote("log", "-1", "--format=%s", "main")).toBe("chore(release): v0.2.0");
      expect(remote("rev-parse", "v0.2.0^{commit}")).toBe(remote("rev-parse", "main"));
      expect(JSON.parse(remote("show", "main:package.json")).version).toBe("0.2.0");
      expect(readFileSync(join(bin, "gh-args"), "utf8").trim()).toBe("release create v0.2.0 --title v0.2.0 --generate-notes --notes-start-tag v0.1.0");
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("bumps the minor for a breaking change before 1.0.0, and the major after it", () => {
    git("tag", "v0.3.4");
    commit("fix!: rename the move command");
    expect(next()).toBe("v0.4.0");
    git("tag", "v1.2.3");
    commit("refactor: drop the old CLI\n\nBREAKING CHANGE: the old CLI is gone.");
    expect(next()).toBe("v2.0.0");
  });
});
