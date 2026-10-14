import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { automaticTitles, isAutomaticTitle, titleResult } from "./automatic-titles";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose()));
});
function setup(
  options: {
    renamed?: boolean;
    fail?: boolean;
    invalidIds?: boolean;
    enabled?: boolean;
    choice?: boolean;
  } = {},
) {
  let title = "Workflow Quality Loop [env_test:quality:123]";
  const thread = () =>
    makeThreadResponse({
      id: "child",
      title,
      originPluginId: "treelanes",
      parentThreadId: "main",
      projectId: "p",
      environmentId: "e",
    });
  const h = createFakePluginHost({
    pluginId: "treelanes",
    settings: options.enabled === undefined ? {} : { automaticTitles: options.enabled },
    sdk: {
      threads: {
        list: async () => [thread()] as never,
        get: async ({ threadId }) =>
          threadId === "main"
            ? makeThreadResponse({ title: "Add invoice payments" })
            : thread(),
        promptHistory: async () => [
          {
            id: "prompt",
            createdAt: 1,
            input: [
              {
                type: "text",
                text: "Review the invoice payment feature",
                mentions: [],
              },
            ],
          },
        ],
        update: async (args) => {
          title = args.title!;
          return thread();
        },
        spawn: async () => makeThreadResponse({ id: "title-thread" }) as never,
        wait: async () => {
          if (options.renamed) title = "My custom name";
          if (options.fail) throw new Error("offline");
          return {} as never;
        },
        output: async () => ({
          output: `Here: {"titles":[{"id":"${options.invalidIds ? "other" : "child"}","title":"Review invoice payments"}]}`,
        }),
        delete: async () => ({ ok: true }) as never,
      },
    },
  });
  hosts.push(h);
  const db = h.bb.storage.database();
  return {
    h,
    titles: automaticTitles(h.bb, db, () =>
      options.choice === false ? null : { providerId: "claude-code", model: "small-model" },
    ),
    title: () => title,
  };
}
describe("automatic titles", () => {
  it("accepts only known automatic workflow titles", () => {
    expect(
      isAutomaticTitle({
        title: "Workflow TDD [env_abc:tdd:123]",
        originPluginId: "treelanes",
      }),
    ).toBe(true);
    expect(
      isAutomaticTitle({
        title: "My own title",
        originPluginId: "treelanes",
      }),
    ).toBe(false);
    expect(
      isAutomaticTitle({
        title: "Workflow TDD [env_abc:tdd:123]",
        originPluginId: null,
      }),
    ).toBe(false);
  });
  it("stores one display title from a deleted hidden thread and keeps the internal name", async () => {
    const { h, titles, title } = setup({ enabled: true });
    expect(await titles.run()).toEqual({ changed: 1 });
    expect(title()).toBe("Workflow Quality Loop [env_test:quality:123]");
    expect(titles.list().rows[0].generated).toBe("Review invoice payments");
    expect(await titles.run()).toEqual({ changed: 0 });
    const [spawn] = h.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawn[0]).toMatchObject({
      projectId: "p",
      environment: { type: "reuse", environmentId: "e" },
      providerId: "claude-code",
      model: "small-model",
      visibility: "hidden",
    });
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(h.harness.inspection.sdk.callsTo("threads.delete")[0][0]).toMatchObject({ threadId: "title-thread" });
    expect(h.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });
  it("is off by default", async () => {
    const { titles, h } = setup();
    expect(await titles.run()).toEqual({ changed: 0 });
    expect(h.harness.inspection.sdk.calls).toHaveLength(0);
  });
  it("records an error and starts no thread without a chosen model", async () => {
    const { titles, h } = setup({ enabled: true, choice: false });
    await expect(titles.run()).rejects.toThrow("Choose a harness and model");
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect((await titles.status()).rows).toMatchObject([{ error: "Choose a harness and model for titles in Settings." }]);
  });
  it("preserves a title edited while inference runs", async () => {
    const { titles, title } = setup({ enabled: true, renamed: true });
    expect(await titles.run()).toEqual({ changed: 0 });
    expect(title()).toBe("My custom name");
  });
  it("keeps the old title on failure and applies a retry delay", async () => {
    const { titles, title, h } = setup({ enabled: true, fail: true });
    await expect(titles.run()).rejects.toThrow("offline");
    expect(title()).toContain("Workflow Quality");
    expect(await titles.run()).toEqual({ changed: 0 });
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("rejects unrelated IDs without changing titles", async () => {
    const { titles, title } = setup({ enabled: true, invalidIds: true });
    await expect(titles.run()).rejects.toThrow("incomplete title batch");
    expect(title()).toContain("Workflow Quality");
  });
  it("rejects long or markup-bearing output", () => {
    for (const title of [
      "one two three four five six seven eight nine",
      "<script>bad</script>",
      "Bad\nname",
    ])
      expect(
        titleResult.safeParse({ titles: [{ id: "a", title }] }).success,
      ).toBe(false);
  });
});
