import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/use-settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { generateMessageId } from "@/types/stream";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import type { SavedPrompt, SavedPromptValue } from "../model";
import { SavedPromptFormSheet } from "./form-sheet";
import { SavedPromptRow } from "./row";

const ThemedPlus = withUnistyles(Plus);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const addIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedMapping} />;

interface EditTarget {
  mode: "create" | "edit";
  prompt?: SavedPrompt;
}

function keyExtractor(prompt: SavedPrompt): string {
  return prompt.id;
}

function createSavedPromptId(): string {
  return `saved_prompt_${generateMessageId()}`;
}

export function SavedPromptsPage(): ReactElement {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const prompts = settings.savedPrompts;
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isAutomaticSendingPending, setIsAutomaticSendingPending] = useState(false);

  const savePrompts = useCallback(
    async (savedPrompts: SavedPrompt[]) => {
      setSaveError(null);
      try {
        await updateSettings({ savedPrompts });
      } catch (error) {
        const message = toErrorMessage(error);
        setSaveError(message);
        throw error;
      }
    },
    [updateSettings],
  );

  const handleCreateOpen = useCallback(() => setEditTarget({ mode: "create" }), []);
  const handleFormClose = useCallback(() => setEditTarget(null), []);
  const handleEditOpen = useCallback(
    (id: string) => {
      const prompt = prompts.find((entry) => entry.id === id);
      if (prompt) {
        setEditTarget({ mode: "edit", prompt });
      }
    },
    [prompts],
  );

  const handleFormSave = useCallback(
    async (value: SavedPromptValue) => {
      const editing = editTarget?.mode === "edit" ? editTarget.prompt : undefined;
      const next = editing
        ? prompts.map((prompt) => (prompt.id === editing.id ? { id: prompt.id, ...value } : prompt))
        : [...prompts, { id: createSavedPromptId(), ...value }];
      await savePrompts(next);
    },
    [editTarget, prompts, savePrompts],
  );

  const reorder = useCallback(
    (id: string, offset: -1 | 1) => {
      const index = prompts.findIndex((prompt) => prompt.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= prompts.length) {
        return;
      }
      const next = [...prompts];
      const [prompt] = next.splice(index, 1);
      if (!prompt) {
        return;
      }
      next.splice(target, 0, prompt);
      void savePrompts(next).catch(() => {});
    },
    [prompts, savePrompts],
  );
  const handleMoveUp = useCallback((id: string) => reorder(id, -1), [reorder]);
  const handleMoveDown = useCallback((id: string) => reorder(id, 1), [reorder]);
  const handleDragEnd = useCallback(
    (next: SavedPrompt[]) => void savePrompts(next).catch(() => {}),
    [savePrompts],
  );

  const handleRemove = useCallback(
    (id: string) => {
      const prompt = prompts.find((entry) => entry.id === id);
      if (!prompt) {
        return;
      }
      void confirmDialog({
        title: t("settings.savedPrompts.remove.title", { name: prompt.name }),
        message: t("settings.savedPrompts.remove.message", { name: prompt.name }),
        confirmLabel: t("settings.savedPrompts.remove.confirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      })
        .then((confirmed) =>
          confirmed ? savePrompts(prompts.filter((entry) => entry.id !== id)) : undefined,
        )
        .catch(() => undefined);
    },
    [prompts, savePrompts, t],
  );

  const handleAutomaticSendingChange = useCallback(
    (savedPromptAutomaticSending: boolean) => {
      setSaveError(null);
      setIsAutomaticSendingPending(true);
      void updateSettings({ savedPromptAutomaticSending })
        .catch((error) => setSaveError(toErrorMessage(error)))
        .finally(() => setIsAutomaticSendingPending(false));
    },
    [updateSettings],
  );

  const renderPrompt = useCallback(
    ({ item, index, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<SavedPrompt>) => (
      <SavedPromptRow
        prompt={item}
        isFirst={index === 0}
        isLast={index === prompts.length - 1}
        isDragging={isActive}
        drag={drag}
        dragHandleProps={dragHandleProps}
        onEdit={handleEditOpen}
        onRemove={handleRemove}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
      />
    ),
    [handleEditOpen, handleMoveDown, handleMoveUp, handleRemove, prompts.length],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleCreateOpen}
        accessibilityLabel={t("settings.savedPrompts.add")}
        testID="saved-prompts-add"
      />
    ),
    [handleCreateOpen, t],
  );

  return (
    <>
      {saveError ? (
        <Alert
          variant="error"
          title={t("settings.savedPrompts.saveError")}
          description={saveError}
          testID="saved-prompts-save-error"
        />
      ) : null}
      <SettingsSection title={t("settings.savedPrompts.behaviorTitle")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.savedPrompts.automaticSending.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.savedPrompts.automaticSending.description")}
              </Text>
            </View>
            <Switch
              value={settings.savedPromptAutomaticSending}
              onValueChange={handleAutomaticSendingChange}
              disabled={isAutomaticSendingPending}
              accessibilityLabel={t("settings.savedPrompts.automaticSending.label")}
              testID="saved-prompts-automatic-sending"
            />
          </View>
        </View>
      </SettingsSection>
      <SettingsSection
        title={t("settings.savedPrompts.listTitle")}
        trailing={addButton}
        testID="saved-prompts-list"
      >
        <View style={settingsStyles.card}>
          {prompts.length > 0 ? (
            <DraggableList
              data={prompts}
              keyExtractor={keyExtractor}
              renderItem={renderPrompt}
              onDragEnd={handleDragEnd}
              scrollEnabled={false}
              useDragHandle
              testID="saved-prompts-draggable-list"
            />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText} testID="saved-prompts-empty">
                {t("settings.savedPrompts.empty")}
              </Text>
              <Button size="sm" leftIcon={addIcon} onPress={handleCreateOpen}>
                {t("settings.savedPrompts.newPrompt")}
              </Button>
            </View>
          )}
        </View>
      </SettingsSection>
      <SavedPromptFormSheet
        visible={editTarget !== null}
        mode={editTarget?.mode ?? "create"}
        {...(editTarget?.prompt ? { prompt: editTarget.prompt } : {})}
        existing={prompts}
        onClose={handleFormClose}
        onSave={handleFormSave}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
