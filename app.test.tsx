// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { STAGES } from "./workflow";

describe("Workflow Board panel", () => {
  it("opens a card thread in the right pane", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            stages: [...STAGES],
            cards: [
              {
                environmentId: "environment-one",
                projectId: "project-one",
                projectName: "Test project",
                worktreeName: "board-worktree",
                branchName: "feat/board",
                stage: "design" as const,
                note: null,
                status: "active" as const,
                hasPendingInteraction: false,
                updatedAt: 2,
                stageUpdatedAt: 1,
                pendingThreadStart: null,
                threads: [
                  {
                    id: "thread-root",
                    title: "Root work",
                    status: "idle" as const,
                    updatedAt: 1,
                    parentThreadId: null,
                    hasPendingInteraction: false,
                  },
                  {
                    id: "thread-child",
                    title: "Child work",
                    status: "active" as const,
                    updatedAt: 2,
                    parentThreadId: "thread-root",
                    hasPendingInteraction: false,
                  },
                ],
              },
            ],
          }),
          moveCard: ({ environmentId, stage }) => ({ environmentId, stage }),
        },
        context: { projectId: "project-one", threadId: null },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Root work" }),
    );

    const chat = await slot.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thread-root");
    expect(chat.getAttribute("data-variant")).toBe("compact");

    fireEvent.click(
      slot.getByRole("button", { name: "Move to next stage" }),
    );
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "moveCard",
        input: { environmentId: "environment-one", stage: "tdd" },
      }),
    );

    fireEvent.click(slot.getByRole("button", { name: "Open full thread" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thread-root",
    });

    fireEvent.click(slot.getByRole("button", { name: "Close thread panel" }));
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();

    fireEvent.click(
      slot.getByRole("button", { name: "Review changes in board-worktree" }),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thread-child",
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(
          "bb.thread.fixedPanelTabsState-thread-child-1",
        ) ?? "null",
      ),
    ).toMatchObject({
      version: 1,
      secondary: {
        activeTabId: "git-diff:git-diff:none",
        isOpen: true,
      },
    });

    slot.lifecycle.unmount();
  });

  it("searches, filters, and opens a new work composer", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            stages: [...STAGES],
            cards: [
              {
                environmentId: "environment-one",
                projectId: "project-one",
                projectName: "Test project",
                worktreeName: "search-worktree",
                branchName: "feat/search",
                stage: "tickets" as const,
                note: "Linear ticket ABC-1",
                status: "idle" as const,
                hasPendingInteraction: false,
                updatedAt: Date.now(),
                stageUpdatedAt: Date.now(),
                pendingThreadStart: null,
                threads: [
                  {
                    id: "thread-one",
                    title: "Searchable work",
                    status: "idle" as const,
                    updatedAt: Date.now(),
                    parentThreadId: null,
                    hasPendingInteraction: false,
                  },
                ],
              },
            ],
          }),
          moveCard: ({ environmentId, stage }) => ({ environmentId, stage }),
        },
        context: { projectId: "project-one", threadId: null },
      },
    );

    expect(
      await slot.findByRole("button", { name: "Searchable work" }),
    ).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Search work" }), {
      target: { value: "not present" },
    });
    await waitFor(() =>
      expect(
        slot.queryByRole("button", { name: "Searchable work" }),
      ).toBeNull(),
    );

    fireEvent.change(slot.getByRole("textbox", { name: "Search work" }), {
      target: { value: "" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Attention" }));
    await waitFor(() =>
      expect(
        slot.queryByRole("button", { name: "Searchable work" }),
      ).toBeNull(),
    );

    fireEvent.click(slot.getByRole("button", { name: "New work" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: { focusPrompt: true },
    });

    slot.lifecycle.unmount();
  });

  it("starts a new thread in the card Git Worktree", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            stages: [...STAGES],
            cards: [
              {
                environmentId: "environment-one",
                projectId: "project-one",
                projectName: "Test project",
                worktreeName: "board-worktree",
                branchName: "feat/board",
                stage: "design" as const,
                note: null,
                status: "idle" as const,
                hasPendingInteraction: false,
                updatedAt: Date.now(),
                stageUpdatedAt: Date.now(),
                pendingThreadStart: null,
                threads: [
                  {
                    id: "thread-one",
                    title: "Existing work",
                    status: "idle" as const,
                    updatedAt: Date.now(),
                    parentThreadId: null,
                    hasPendingInteraction: false,
                  },
                ],
              },
            ],
          }),
          moveCard: ({ environmentId, stage }) => ({ environmentId, stage }),
          createThread: () => ({ threadId: "thread-new" }),
          getComposerDefaults: () => ({
            providerId: "claude-code",
            model: "claude-opus-4-1",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
          }),
        },
        context: { projectId: "project-one", threadId: null },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", {
        name: "New thread in board-worktree",
      }),
    );

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "board",
      options: { subPath: "new-thread/environment-one" },
    });

    const pageSlot = renderSlot(
      app.navPanels[0]!,
      { subPath: "new-thread/environment-one" },
      {
        rpc: {
          getBoard: () => ({
            stages: [...STAGES],
            cards: [
              {
                environmentId: "environment-one",
                projectId: "project-one",
                projectName: "Test project",
                worktreeName: "board-worktree",
                branchName: "feat/board",
                stage: "design" as const,
                note: null,
                status: "idle" as const,
                hasPendingInteraction: false,
                updatedAt: Date.now(),
                stageUpdatedAt: Date.now(),
                pendingThreadStart: null,
                threads: [
                  {
                    id: "thread-one",
                    title: "Existing work",
                    status: "idle" as const,
                    updatedAt: Date.now(),
                    parentThreadId: null,
                    hasPendingInteraction: false,
                  },
                ],
              },
            ],
          }),
          moveCard: ({ environmentId, stage }) => ({ environmentId, stage }),
          createThread: () => ({ threadId: "thread-new" }),
          getComposerDefaults: () => ({
            providerId: "claude-code",
            model: "claude-opus-4-1",
            reasoningLevel: "high" as const,
            permissionMode: "auto" as const,
          }),
        },
        context: { projectId: "project-one", threadId: null },
      },
    );

    const composer = await pageSlot.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-project-id")).toBe("project-one");
    expect(composer.getAttribute("data-default-provider-id")).toBe(
      "claude-code",
    );
    expect(composer.getAttribute("data-default-model")).toBe(
      "claude-opus-4-1",
    );
    expect(composer.getAttribute("data-default-environment")).toBe(
      JSON.stringify({ type: "reuse", environmentId: "environment-one" }),
    );

    fireEvent.change(pageSlot.getByTestId("bb-new-thread-composer-input"), {
      target: { value: "Review this worktree" },
    });
    fireEvent.click(pageSlot.getByTestId("bb-new-thread-composer-submit"));

    await waitFor(() =>
      expect(pageSlot.inspection.rpcCalls).toContainEqual({
        method: "createThread",
        input: expect.objectContaining({
          request: expect.objectContaining({
            projectId: "project-one",
            environment: {
              type: "reuse",
              environmentId: "environment-one",
            },
          }),
        }),
      }),
    );
    await waitFor(() =>
      expect(pageSlot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thread-new",
      }),
    );

    pageSlot.lifecycle.unmount();
    slot.lifecycle.unmount();
  });

  it("starts an offered stage thread from its Worktree Card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          getBoard: () => ({
            stages: [...STAGES],
            cards: [
              {
                environmentId: "environment-one",
                projectId: "project-one",
                projectName: "Test project",
                worktreeName: "board-worktree",
                branchName: "feat/board",
                stage: "pr" as const,
                note: null,
                status: "idle" as const,
                hasPendingInteraction: false,
                updatedAt: Date.now(),
                stageUpdatedAt: Date.now(),
                pendingThreadStart: {
                  stage: "pr" as const,
                  label: "Start PR thread",
                },
                threads: [
                  {
                    id: "thread-simplify",
                    title: "Simplify the changes",
                    status: "idle" as const,
                    updatedAt: Date.now(),
                    parentThreadId: null,
                    hasPendingInteraction: false,
                  },
                ],
              },
            ],
          }),
          moveCard: ({ environmentId, stage }) => ({ environmentId, stage }),
          startStageThread: () => ({ threadId: "thread-pr" }),
        },
        context: { projectId: "project-one", threadId: null },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", {
        name: "Start PR thread in board-worktree",
      }),
    );

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "startStageThread",
        input: { environmentId: "environment-one" },
      }),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thread-pr",
    });
    slot.lifecycle.unmount();
  });
});
