import { expect, it } from "vitest";
import { withGeneratedTitle } from "./display-title";
import { fixture } from "./test-fixtures";
it("uses the Luna display name without changing the source or identity", () => {
  const thread = fixture("child", "env", {
    title: "Workflow TDD [env_abc:tdd:1]",
  });
  const display = withGeneratedTitle(thread, {
    threadId: "child",
    original: thread.title!,
    generated: "Test invoice payments",
  });
  expect(display.title).toBe("Test invoice payments");
  expect(display.id).toBe(thread.id);
  expect(thread.title).toBe("Workflow TDD [env_abc:tdd:1]");
});
it("shows a manual rename instead of a saved Luna title", () => {
  const thread = fixture("child", "env", { title: "My custom title" });
  expect(
    withGeneratedTitle(thread, {
      threadId: "child",
      original: "Workflow TDD [env_abc:tdd:1]",
      generated: "Test invoice payments",
    }),
  ).toBe(thread);
});
