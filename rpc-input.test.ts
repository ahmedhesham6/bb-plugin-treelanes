import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { rpcContract } from "./server";
import { sidebarRpcContract } from "./sidebar/server";

const methods = Object.entries({ ...rpcContract, ...sidebarRpcContract })
  .map(([name, method]) => [name, method.input as z.ZodType] as const);
const accepts = (input: z.ZodType, value: unknown) => input.safeParse(value).success;
const noFields = methods.filter(([, input]) => accepts(input, {}));

describe("RPC input", () => {
  it("accepts a missing or null input for each method without input fields, as the bb CLI sends", () => {
    expect(noFields.map(([name]) => name).sort())
      .toEqual(["getTaskMap", "listGroups", "listLifecycle", "listOrder", "listTitles"]);
    for (const [name, input] of noFields) {
      expect(accepts(input, null), name).toBe(true);
      expect(accepts(input, undefined), name).toBe(true);
      expect(accepts(input, { unexpected: true }), name).toBe(false);
    }
  });

  it("keeps strict validation for methods with input fields", () => {
    for (const [name, input] of methods.filter(([, input]) => !accepts(input, {}))) {
      expect(accepts(input, null), name).toBe(false);
    }
  });
});
