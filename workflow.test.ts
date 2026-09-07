import { describe, expect, it } from "vitest";
import {
  automatedNextStage,
  reportedCompletionTransition,
  reportsFinishedGrilling,
  reportsFinishedSimplify,
  reportsFinishedTdd,
  reportsQualityClear,
} from "./workflow";

const completionCases = [
  {
    name: "Grilling",
    marker: "[workflow:grilling-complete]",
    report: reportsFinishedGrilling,
    sourceStage: "design" as const,
    nextStage: "tdd" as const,
    note: "Grilling finished. The design is ready for TDD.",
    broadPhrase: "Grilling is complete.",
  },
  {
    name: "TDD",
    marker: "[workflow:tdd-complete]",
    report: reportsFinishedTdd,
    sourceStage: "tdd" as const,
    nextStage: "quality" as const,
    note: "TDD finished. The quality loop is ready.",
    broadPhrase: "TDD is complete.",
  },
  {
    name: "Quality",
    marker: "[workflow:quality-clear]",
    report: reportsQualityClear,
    sourceStage: "quality" as const,
    nextStage: "simplify" as const,
    note: "The quality loop has no findings. Simplify is ready.",
    broadPhrase: "The quality review has no findings.",
  },
  {
    name: "Simplify",
    marker: "[workflow:simplify-complete]",
    report: reportsFinishedSimplify,
    sourceStage: "simplify" as const,
    nextStage: "pr" as const,
    note: "Simplify finished. The pull request is ready.",
    broadPhrase: "Simplify is complete.",
  },
] as const;

describe("workflow completion markers", () => {
  it.each(completionCases)(
    "accepts one exact $name marker on the final non-empty line",
    ({ marker, report }) => {
      expect(
        report(`The work is complete.\n\n  \t${marker}\t  \n\n`),
      ).toBe(true);
    },
  );

  it.each(completionCases)(
    "maps the exact $name marker to its next stage",
    ({ marker, sourceStage, nextStage, note }) => {
      const text = `The checks passed.\n${marker}\n`;

      expect(reportedCompletionTransition(text)).toEqual({
        sourceStage,
        stage: nextStage,
        note,
      });
      expect(automatedNextStage(sourceStage, text)).toEqual({
        stage: nextStage,
        note,
      });
    },
  );

  it.each(completionCases)(
    "rejects broad $name completion phrases",
    ({ broadPhrase, report }) => {
      expect(report(broadPhrase)).toBe(false);
      expect(reportedCompletionTransition(broadPhrase)).toBeNull();
    },
  );

  it.each(completionCases)(
    "rejects quoted, inline, and negated $name markers",
    ({ marker, report }) => {
      const examples = [
        `"${marker}"`,
        `The result is ${marker}.`,
        `Do not report ${marker}.`,
        `not ${marker}`,
        `> ${marker}`,
      ];

      for (const example of examples) {
        expect(report(example), example).toBe(false);
        expect(reportedCompletionTransition(example), example).toBeNull();
      }
    },
  );

  it.each(completionCases)(
    "rejects a fenced example containing a $name marker",
    ({ marker, report }) => {
      const fence = "```";
      const example = `Example output:\n\n${fence}text\n${marker}\n${fence}\n`;

      expect(report(example)).toBe(false);
      expect(reportedCompletionTransition(example)).toBeNull();
    },
  );

  it.each(completionCases)(
    "requires the $name marker to be the final non-empty line",
    ({ marker, report }) => {
      const example = `${marker}\nMore work remains.`;

      expect(report(example)).toBe(false);
      expect(reportedCompletionTransition(example)).toBeNull();
    },
  );

  it("rejects ambiguous messages with different standalone markers", () => {
    const text =
      "The implementation is complete.\n" +
      "[workflow:tdd-complete]\n" +
      "The review is also complete.\n" +
      "[workflow:quality-clear]\n";

    expect(reportsFinishedTdd(text)).toBe(false);
    expect(reportsQualityClear(text)).toBe(false);
    expect(reportedCompletionTransition(text)).toBeNull();
  });

  it("requires the marker spelling to match exactly", () => {
    const text = "[WORKFLOW:TDD-COMPLETE]";

    expect(reportsFinishedTdd(text)).toBe(false);
    expect(reportedCompletionTransition(text)).toBeNull();
  });
});
