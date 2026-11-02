import type { BbPluginApi } from "@get-bb/plugin-sdk";

type DispatchThread = {
  id: string;
  title?: string | null;
  titleFallback?: string | null;
  status: string;
  hasPendingInteraction?: boolean;
  activity?: {
    activeWorkflowCount: number;
    activeBackgroundAgentCount: number;
    activePlanModeCount: number;
    activeGoalCount: number;
  };
};

// Background commands can outlive a turn and never hold dispatch or retry.
export function holdsDispatch(thread: Pick<DispatchThread, "status" | "activity">): boolean {
  const activity = thread.activity;
  return ["active", "pending", "starting", "stopping"].includes(thread.status) ||
    (activity?.activeWorkflowCount ?? 0) > 0 ||
    (activity?.activeBackgroundAgentCount ?? 0) > 0 ||
    (activity?.activePlanModeCount ?? 0) > 0 ||
    (activity?.activeGoalCount ?? 0) > 0;
}

export async function findDispatchHolder<T extends DispatchThread>(
  sdk: BbPluginApi["sdk"], threads: readonly T[], orchestratorId: string | null,
): Promise<T | undefined> {
  const others = threads.filter(thread => thread.id !== orchestratorId);
  const live = others.find(thread => holdsDispatch(thread) || thread.hasPendingInteraction);
  if (live) return live;
  for (const thread of others) {
    if ((await sdk.threads.queuedMessages.list({ threadId: thread.id })).length ||
        (await sdk.threads.interactions.list({ threadId: thread.id })).length) return thread;
  }
}

export function dispatchHoldMessage(thread: DispatchThread): string {
  return `Waiting for thread ${thread.id} (${thread.title ?? thread.titleFallback ?? "Untitled thread"}) to finish its work.`;
}
