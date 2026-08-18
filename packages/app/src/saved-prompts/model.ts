export interface SavedPrompt {
  id: string;
  name: string;
  body: string;
}

export interface SavedPromptValue {
  name: string;
  body: string;
}

export interface TextSelection {
  start: number;
  end: number;
}

export interface SavedPromptSelectionResult {
  text: string;
  selection: TextSelection;
}

export type SavedPromptFieldError = "required" | "duplicate";

export type SavedPromptValidation =
  | { valid: true; value: SavedPromptValue }
  | {
      valid: false;
      nameError?: SavedPromptFieldError;
      bodyError?: SavedPromptFieldError;
    };

interface SavedPromptCandidate {
  id?: unknown;
  name?: unknown;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSavedPromptCandidate(value: unknown): SavedPrompt | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate: SavedPromptCandidate = value;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.body !== "string"
  ) {
    return null;
  }
  const id = candidate.id.trim();
  const name = candidate.name.trim();
  if (!id || !name || !candidate.body.trim()) {
    return null;
  }
  return { id, name, body: candidate.body };
}

export function normalizeSavedPrompts(value: unknown): SavedPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const prompts: SavedPrompt[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const candidate of value) {
    const prompt = normalizeSavedPromptCandidate(candidate);
    if (!prompt || ids.has(prompt.id) || names.has(prompt.name)) {
      continue;
    }
    ids.add(prompt.id);
    names.add(prompt.name);
    prompts.push(prompt);
  }
  return prompts;
}

export function validateSavedPrompt(input: {
  id?: string;
  name: string;
  body: string;
  existing: readonly SavedPrompt[];
}): SavedPromptValidation {
  const name = input.name.trim();
  let nameError: SavedPromptFieldError | undefined;
  if (!name) {
    nameError = "required";
  } else if (
    input.existing.some((prompt) => prompt.id !== input.id && prompt.name.trim() === name)
  ) {
    nameError = "duplicate";
  }
  const bodyError: SavedPromptFieldError | undefined = input.body.trim() ? undefined : "required";
  if (nameError || bodyError) {
    return {
      valid: false,
      ...(nameError ? { nameError } : {}),
      ...(bodyError ? { bodyError } : {}),
    };
  }
  return { valid: true, value: { name, body: input.body } };
}

function boundSelectionIndex(value: number, textLength: number): number {
  if (!Number.isFinite(value)) {
    return textLength;
  }
  return Math.min(textLength, Math.max(0, Math.floor(value)));
}

export type SavedPromptComposerAction = "insert" | "send" | "noop";

export type SavedPromptComposerDismissReason = "select" | "escape";

export interface SavedPromptComposerPlan {
  action: SavedPromptComposerAction;
  requestComposerFocus: boolean;
}

export function planSavedPromptComposerDismiss(input: {
  automaticSending: boolean;
  canSend: boolean;
  reason: SavedPromptComposerDismissReason;
}): SavedPromptComposerPlan {
  if (input.reason === "escape") {
    return { action: "noop", requestComposerFocus: true };
  }
  if (!input.automaticSending) {
    return { action: "insert", requestComposerFocus: true };
  }
  if (input.canSend) {
    return { action: "send", requestComposerFocus: false };
  }
  return { action: "noop", requestComposerFocus: false };
}

export function applySavedPromptToSelection(input: {
  text: string;
  selection: TextSelection;
  body: string;
}): SavedPromptSelectionResult {
  const start = boundSelectionIndex(
    Math.min(input.selection.start, input.selection.end),
    input.text.length,
  );
  const end = boundSelectionIndex(
    Math.max(input.selection.start, input.selection.end),
    input.text.length,
  );
  const text = `${input.text.slice(0, start)}${input.body}${input.text.slice(end)}`;
  const cursor = start + input.body.length;
  return { text, selection: { start: cursor, end: cursor } };
}
