import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { toErrorMessage } from "@/utils/error-messages";
import type { SavedPrompt, SavedPromptFieldError, SavedPromptValue } from "../model";
import { useSavedPromptFormModel, useSavedPromptFormState } from "../use-form-model";

export interface SavedPromptFormSheetProps {
  visible: boolean;
  mode: "create" | "edit";
  prompt?: SavedPrompt;
  existing: readonly SavedPrompt[];
  onClose: () => void;
  onSave: (value: SavedPromptValue) => Promise<void>;
}

function openKey(props: SavedPromptFormSheetProps): string {
  return props.mode === "edit" ? `edit:${props.prompt?.id ?? ""}` : "create";
}

export function SavedPromptFormSheet(props: SavedPromptFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<SavedPromptFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (!closeRequestedRef.current) {
        setRenderedProps(props);
        setSheetVisible(true);
      }
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenSavedPromptFormSheet
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function validationMessage(
  field: "name" | "body",
  error: SavedPromptFieldError | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!error) {
    return null;
  }
  if (field === "name" && error === "duplicate") {
    return t("settings.savedPrompts.validation.nameDuplicate");
  }
  return t(
    field === "name"
      ? "settings.savedPrompts.validation.nameRequired"
      : "settings.savedPrompts.validation.bodyRequired",
  );
}

function OpenSavedPromptFormSheet({
  visible,
  mode,
  prompt,
  existing,
  onClose,
  onDismiss,
  onSave,
}: SavedPromptFormSheetProps & { onDismiss: () => void }): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const snapshot = useMemo(
    () => ({ mode, ...(prompt ? { prompt } : {}), existing }),
    [existing, mode, prompt],
  );
  const model = useSavedPromptFormModel(snapshot);
  const state = useSavedPromptFormState(model);
  const header = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit"
          ? t("settings.savedPrompts.form.editTitle")
          : t("settings.savedPrompts.form.createTitle"),
    }),
    [mode, t],
  );
  const nameError = validationMessage("name", state.nameError, t);
  const bodyError = validationMessage("body", state.bodyError, t);

  const handleSave = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) {
      return;
    }
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave(value);
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onClose, onSave]);

  const handleSavePress = useCallback(() => void handleSave(), [handleSave]);
  const handleCancel = useCallback(() => {
    if (!state.isSubmitting) {
      onClose();
    }
  }, [onClose, state.isSubmitting]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={handleCancel}
      onDismiss={onDismiss}
      desktopMaxWidth={520}
      testID="saved-prompt-form-sheet"
    >
      <View style={styles.body}>
        <Field
          label={t("settings.savedPrompts.form.nameLabel")}
          error={nameError}
          testID="saved-prompt-name-field"
        >
          <FormTextInput
            initialValue={prompt?.name ?? ""}
            onChangeText={model.setName}
            placeholder={t("settings.savedPrompts.form.namePlaceholder")}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("settings.savedPrompts.form.nameLabel")}
            testID="saved-prompt-name-input"
          />
        </Field>
        <Field
          label={t("settings.savedPrompts.form.bodyLabel")}
          error={bodyError}
          testID="saved-prompt-body-field"
        >
          <FormTextInput
            initialValue={prompt?.body ?? ""}
            onChangeText={model.setBody}
            placeholder={t("settings.savedPrompts.form.bodyPlaceholder")}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            style={styles.bodyInput}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("settings.savedPrompts.form.bodyLabel")}
            testID="saved-prompt-body-input"
          />
        </Field>
        {state.submitError ? (
          <Text accessibilityRole="alert" style={styles.submitError} testID="saved-prompt-error">
            {state.submitError}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.action}
            onPress={handleCancel}
            disabled={state.isSubmitting}
            testID="saved-prompt-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.action}
            onPress={handleSavePress}
            disabled={!state.canSubmit}
            loading={state.isSubmitting}
            testID="saved-prompt-save"
          >
            {state.isSubmitting
              ? t("settings.savedPrompts.form.saving")
              : t("settings.savedPrompts.form.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  bodyInput: {
    minHeight: 132,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  action: {
    flex: 1,
  },
}));
