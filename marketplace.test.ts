import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "./package.json" with { type: "json" };
import marketplace from "./marketplace.json" with { type: "json" };
import { PLUGIN_ID } from "./plugin-id";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const [entry] = marketplace.plugins;

describe("marketplace listing", () => {
  it("lists this plugin with the same text as its manifest and overview file", () => {
    expect(marketplace.plugins).toHaveLength(1);
    expect(entry!.id).toBe(PLUGIN_ID);
    expect(entry!.displayName).toBe(manifest.bb.name);
    expect(entry!.description.startsWith(`${manifest.bb.description} `)).toBe(true);
    expect(entry!.overview).toBe(read("./PLUGIN_OVERVIEW.md"));
  });

  it("keeps the store rules", () => {
    expect(manifest.bb.description.length).toBeLessThanOrEqual(140);
    expect(entry!.overview.length).toBeLessThanOrEqual(4000);
    expect(entry!.overview).not.toMatch(/^# |<[a-z]|!\[|^\|/m);
    expect(existsSync(new URL(entry!.icon.url, import.meta.url))).toBe(true);
    expect(entry!.screenshots.length).toBeLessThanOrEqual(6);
    for (const url of entry!.screenshots) {
      const local = url.replace("https://raw.githubusercontent.com/ahmedhesham6/bb-plugin-treelanes/main/", "./");
      expect(existsSync(new URL(local, import.meta.url)), url).toBe(true);
    }
  });
});
