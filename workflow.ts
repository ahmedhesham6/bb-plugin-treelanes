export const STAGES = [
  {
    id: "tickets",
    label: "Tickets",
    shortLabel: "Tickets",
    description: "New Linear tickets and work that you create.",
  },
  {
    id: "design",
    label: "Design",
    shortLabel: "Design",
    description: "Shape the work with Grilling.",
  },
  {
    id: "tdd",
    label: "TDD",
    shortLabel: "TDD",
    description: "Define seams, write tests, and build the change.",
  },
  {
    id: "quality",
    label: "Quality Loop",
    shortLabel: "Quality",
    description: "Run strict code review until it has no findings.",
  },
  {
    id: "simplify",
    label: "Simplify",
    shortLabel: "Simplify",
    description: "Reduce code size and remove needless parts.",
  },
  {
    id: "review",
    label: "Code Review",
    shortLabel: "Review",
    description: "Run /code-review on external changes without starting implementation work.",
  },
  {
    id: "pr",
    label: "PR Watch",
    shortLabel: "PR",
    description: "Open a ready-for-review pull request when needed, then watch it.",
  },
  {
    id: "done",
    label: "Done",
    shortLabel: "Done",
    description: "The pull request has merged.",
  },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export const STAGE_IDS = STAGES.map((stage) => stage.id) as [
  StageId,
  ...StageId[],
];

export const DEFAULT_STAGE: StageId = "tickets";

export function isStageId(value: string): value is StageId {
  return STAGE_IDS.includes(value as StageId);
}

export function stageLabel(stageId: StageId): string {
  return STAGES.find((stage) => stage.id === stageId)?.label ?? stageId;
}

const COMPLETION_MARKERS = [
  "[workflow:grilling-complete]",
  "[workflow:tdd-complete]",
  "[workflow:quality-clear]",
  "[workflow:simplify-complete]",
] as const;

type CompletionMarker = (typeof COMPLETION_MARKERS)[number];
type Fence = { character: "`" | "~"; length: number };

const COMPLETION_MARKER_SET = new Set<string>(COMPLETION_MARKERS);

function readFence(line: string): (Fence & { suffix: string }) | null {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  const sequence = match?.[1];
  if (!sequence) return null;
  return {
    character: sequence[0] as "`" | "~",
    length: sequence.length,
    suffix: match?.[2] ?? "",
  };
}

function completionMarker(text: string): CompletionMarker | null {
  let marker: CompletionMarker | null = null;
  let markerCount = 0;
  let lastNonEmptyLine = "";
  let fence: Fence | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine) lastNonEmptyLine = trimmedLine;

    const fenceLine = readFence(line);
    if (fence) {
      if (
        fenceLine &&
        fenceLine.character === fence.character &&
        fenceLine.length >= fence.length &&
        fenceLine.suffix.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }

    if (fenceLine) {
      fence = {
        character: fenceLine.character,
        length: fenceLine.length,
      };
      continue;
    }

    if (COMPLETION_MARKER_SET.has(trimmedLine)) {
      marker = trimmedLine as CompletionMarker;
      markerCount += 1;
    }
  }

  return markerCount === 1 && lastNonEmptyLine === marker ? marker : null;
}

export function reportsFinishedGrilling(text: string): boolean {
  return completionMarker(text) === "[workflow:grilling-complete]";
}

export function reportsFinishedTdd(text: string): boolean {
  return completionMarker(text) === "[workflow:tdd-complete]";
}

export function reportsQualityClear(text: string): boolean {
  return completionMarker(text) === "[workflow:quality-clear]";
}

export function reportsFinishedSimplify(text: string): boolean {
  return completionMarker(text) === "[workflow:simplify-complete]";
}

export type CompletionTransition = {
  sourceStage: StageId;
  stage: StageId;
  note: string;
};

export function reportedCompletionTransition(
  text: string,
): CompletionTransition | null {
  switch (completionMarker(text)) {
    case "[workflow:grilling-complete]":
      return {
        sourceStage: "design",
        stage: "tdd",
        note: "Grilling finished. The design is ready for TDD.",
      };
    case "[workflow:tdd-complete]":
      return {
        sourceStage: "tdd",
        stage: "quality",
        note: "TDD finished. The quality loop is ready.",
      };
    case "[workflow:quality-clear]":
      return {
        sourceStage: "quality",
        stage: "simplify",
        note: "The quality loop has no findings. Simplify is ready.",
      };
    case "[workflow:simplify-complete]":
      return {
        sourceStage: "simplify",
        stage: "pr",
        note: "Simplify finished. The pull request is ready.",
      };
    default:
      return null;
  }
}

export function automatedNextStage(
  currentStage: StageId,
  text: string,
): { stage: StageId; note: string } | null {
  const transition = reportedCompletionTransition(text);
  if (!transition || transition.sourceStage !== currentStage) return null;
  return { stage: transition.stage, note: transition.note };
}
