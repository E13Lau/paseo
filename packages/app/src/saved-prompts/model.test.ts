import { describe, expect, it } from "vitest";
import { applySavedPromptToSelection, normalizeSavedPrompts, validateSavedPrompt } from "./model";

describe("normalizeSavedPrompts", () => {
  it("keeps valid prompts in stored order while preserving body whitespace", () => {
    expect(
      normalizeSavedPrompts([
        { id: " first ", name: " Continue ", body: "\nkeep this\n" },
        { id: "second", name: "Review", body: "Review the changes" },
      ]),
    ).toEqual([
      { id: "first", name: "Continue", body: "\nkeep this\n" },
      { id: "second", name: "Review", body: "Review the changes" },
    ]);
  });

  it("drops malformed, duplicate-name, and duplicate-id entries without rejecting settings", () => {
    expect(
      normalizeSavedPrompts([
        { id: "one", name: " Continue ", body: "go" },
        { id: "two", name: "Continue", body: "duplicate name" },
        { id: "one", name: "Different", body: "duplicate id" },
        { id: "three", name: "Blank", body: "   \n" },
        { id: "four", name: "   ", body: "valid" },
        null,
      ]),
    ).toEqual([{ id: "one", name: "Continue", body: "go" }]);
  });

  it("falls back to an empty list for non-array storage", () => {
    expect(normalizeSavedPrompts({ prompts: [] })).toEqual([]);
  });
});

describe("validateSavedPrompt", () => {
  const existing = [
    { id: "one", name: "Continue", body: "go" },
    { id: "two", name: "Review", body: "review" },
  ];

  it("trims names, preserves bodies, and excludes the edited prompt from uniqueness checks", () => {
    expect(
      validateSavedPrompt({
        id: "one",
        name: " Continue ",
        body: "\n  keep me  \n",
        existing,
      }),
    ).toEqual({
      valid: true,
      value: { name: "Continue", body: "\n  keep me  \n" },
    });
  });

  it("returns field-level failures for blank and duplicate values", () => {
    expect(validateSavedPrompt({ name: " Review ", body: "  ", existing })).toEqual({
      valid: false,
      nameError: "duplicate",
      bodyError: "required",
    });
  });
});

describe("applySavedPromptToSelection", () => {
  it("replaces the exact selected range and places the cursor after the inserted body", () => {
    expect(
      applySavedPromptToSelection({
        text: "Please old text now",
        selection: { start: 7, end: 15 },
        body: "new\ntext",
      }),
    ).toEqual({
      text: "Please new\ntext now",
      selection: { start: 15, end: 15 },
    });
  });

  it("inserts consecutively at the current cursor without adding whitespace", () => {
    const first = applySavedPromptToSelection({
      text: "ab",
      selection: { start: 1, end: 1 },
      body: "X",
    });
    const second = applySavedPromptToSelection({
      text: first.text,
      selection: first.selection,
      body: " Y ",
    });

    expect(second).toEqual({
      text: "aX Y b",
      selection: { start: 5, end: 5 },
    });
  });

  it("bounds stale selections to the current text", () => {
    expect(
      applySavedPromptToSelection({
        text: "abc",
        selection: { start: 20, end: 30 },
        body: "x",
      }),
    ).toEqual({ text: "abcx", selection: { start: 4, end: 4 } });
  });
});
