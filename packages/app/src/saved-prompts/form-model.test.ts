import { describe, expect, it } from "vitest";
import { openSavedPromptForm } from "./form-model";

const existing = [
  { id: "one", name: "Continue", body: "go" },
  { id: "two", name: "Review", body: "review" },
];

describe("openSavedPromptForm", () => {
  it("opens create with a fresh empty state", () => {
    const model = openSavedPromptForm({ mode: "create", existing });

    expect(model.getState()).toMatchObject({
      mode: "create",
      name: "",
      body: "",
      nameError: null,
      bodyError: null,
      canSubmit: false,
      submitValue: null,
    });
  });

  it("reopens edit with the complete stored name and body", () => {
    const model = openSavedPromptForm({ mode: "edit", prompt: existing[0], existing });

    expect(model.getState()).toMatchObject({
      mode: "edit",
      name: "Continue",
      body: "go",
      canSubmit: true,
      submitValue: { name: "Continue", body: "go" },
    });
  });

  it("publishes rendered validation failures without losing entered values", () => {
    const model = openSavedPromptForm({ mode: "create", existing });

    model.setName(" Review ");
    model.setBody(" \n ");

    expect(model.getState()).toMatchObject({
      name: " Review ",
      body: " \n ",
      nameError: "duplicate",
      bodyError: "required",
      canSubmit: false,
      submitValue: null,
    });
  });

  it("submits a trimmed name with a verbatim multiline body", () => {
    const model = openSavedPromptForm({ mode: "create", existing });

    model.setName("  Plan  ");
    model.setBody("\nFirst\nSecond\n");

    expect(model.getState()).toMatchObject({
      canSubmit: true,
      submitValue: { name: "Plan", body: "\nFirst\nSecond\n" },
    });
  });

  it("stops publishing after close", () => {
    const model = openSavedPromptForm({ mode: "create", existing });
    let publishes = 0;
    model.subscribe(() => {
      publishes += 1;
    });

    model.close();
    model.setName("ignored");

    expect(publishes).toBe(0);
    expect(model.getState().name).toBe("");
  });
});
