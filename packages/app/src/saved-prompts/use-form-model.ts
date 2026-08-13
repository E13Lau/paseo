import { useEffect, useState, useSyncExternalStore } from "react";
import {
  openSavedPromptForm,
  type SavedPromptFormModel,
  type SavedPromptFormSnapshot,
  type SavedPromptFormState,
} from "./form-model";

export function useSavedPromptFormModel(snapshot: SavedPromptFormSnapshot): SavedPromptFormModel {
  const [model] = useState(() => openSavedPromptForm(snapshot));

  useEffect(() => {
    return () => model.close();
  }, [model]);

  return model;
}

export function useSavedPromptFormState(model: SavedPromptFormModel): SavedPromptFormState {
  return useSyncExternalStore(model.subscribe, model.getState, model.getState);
}
