import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

/**
 * The part of the GitHub PR Status plugin's `pullRequests` read that the
 * badge uses. Each key is an environment id.
 */
const githubPrStatus = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
            attention: z.string(),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
    // The tag the GitHub PR Status plugin publishes when a row changes.
    // Without it bb does not refresh the badge.
    keyTags: (key) => [`environment:${key}`],
  },
});

/**
 * The pull request for the branch of one environment. Null when there is no
 * environment, no pull request, or the read fails, which includes a disabled
 * GitHub PR Status plugin.
 */
export function usePullRequest(environmentId: string | null) {
  const { data } = useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const row = environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}
