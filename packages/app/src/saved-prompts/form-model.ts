import {
  validateSavedPrompt,
  type SavedPrompt,
  type SavedPromptFieldError,
  type SavedPromptValue,
} from "./model";

export interface SavedPromptFormSnapshot {
  mode: "create" | "edit";
  prompt?: SavedPrompt;
  existing: readonly SavedPrompt[];
}

export interface SavedPromptFormState {
  mode: "create" | "edit";
  name: string;
  body: string;
  nameError: SavedPromptFieldError | null;
  bodyError: SavedPromptFieldError | null;
  isSubmitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
  submitValue: SavedPromptValue | null;
}

export interface SavedPromptFormModel {
  getState: () => SavedPromptFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setName: (value: string) => void;
  setBody: (value: string) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
}

export function openSavedPromptForm(snapshot: SavedPromptFormSnapshot): SavedPromptFormModel {
  let listeners = new Set<() => void>();
  let closed = false;
  let nameTouched = false;
  let bodyTouched = false;
  let state: SavedPromptFormState = derive({
    mode: snapshot.mode,
    name: snapshot.prompt?.name ?? "",
    body: snapshot.prompt?.body ?? "",
    nameError: null,
    bodyError: null,
    isSubmitting: false,
    submitError: null,
    canSubmit: false,
    submitValue: null,
  });

  function derive(incoming: SavedPromptFormState): SavedPromptFormState {
    const validation = validateSavedPrompt({
      ...(snapshot.prompt ? { id: snapshot.prompt.id } : {}),
      name: incoming.name,
      body: incoming.body,
      existing: snapshot.existing,
    });
    const validationNameError = validation.valid ? null : (validation.nameError ?? null);
    const validationBodyError = validation.valid ? null : (validation.bodyError ?? null);
    return {
      ...incoming,
      nameError: nameTouched ? validationNameError : null,
      bodyError: bodyTouched ? validationBodyError : null,
      canSubmit: validation.valid && !incoming.isSubmitting,
      submitValue: validation.valid ? validation.value : null,
    };
  }

  function publish(next: SavedPromptFormState): void {
    if (closed) {
      return;
    }
    state = derive(next);
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      listeners = new Set();
    },
    setName(value) {
      nameTouched = true;
      publish({ ...state, name: value, submitError: null });
    },
    setBody(value) {
      bodyTouched = true;
      publish({ ...state, body: value, submitError: null });
    },
    setSubmitting(value) {
      publish({ ...state, isSubmitting: value });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}
