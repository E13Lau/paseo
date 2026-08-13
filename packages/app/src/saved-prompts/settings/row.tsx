import { useCallback, useMemo, type ReactElement, type Ref } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, GripVertical, Pencil, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { Text } from "react-native";
import type { SavedPrompt } from "../model";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedGrip = withUnistyles(GripVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedMapping} />;
const editIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedMapping} />;
const removeIcon = <ThemedTrash size={ICON_SIZE.sm} uniProps={destructiveMapping} />;
const dragIcon = <ThemedGrip size={ICON_SIZE.sm} uniProps={mutedMapping} />;

export interface SavedPromptRowProps {
  prompt: SavedPrompt;
  isFirst: boolean;
  isLast: boolean;
  isDragging: boolean;
  drag: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

export function SavedPromptRow({
  prompt,
  isFirst,
  isLast,
  isDragging,
  drag,
  dragHandleProps,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: SavedPromptRowProps): ReactElement {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(prompt.id), [onEdit, prompt.id]);
  const handleRemove = useCallback(() => onRemove(prompt.id), [onRemove, prompt.id]);
  const handleMoveUp = useCallback(() => onMoveUp(prompt.id), [onMoveUp, prompt.id]);
  const handleMoveDown = useCallback(() => onMoveDown(prompt.id), [onMoveDown, prompt.id]);
  const rowStyle = useMemo(
    () => [
      settingsStyles.row,
      isFirst ? null : settingsStyles.rowBorder,
      styles.row,
      isDragging ? styles.dragging : null,
    ],
    [isDragging, isFirst],
  );
  const {
    role: _role,
    tabIndex: _tabIndex,
    "aria-roledescription": _roleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  return (
    <View style={rowStyle} testID={`saved-prompt-row-${prompt.id}`}>
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
      >
        <Button
          variant="ghost"
          size="sm"
          leftIcon={dragIcon}
          onLongPress={drag}
          accessibilityLabel={t("settings.savedPrompts.actions.reorder", { name: prompt.name })}
          accessibilityHint={t("settings.savedPrompts.actions.reorderHint")}
          testID={`saved-prompt-drag-${prompt.id}`}
        />
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {prompt.name}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {prompt.body.replace(/\s+/g, " ").trim()}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={t("settings.savedPrompts.actions.moveUp", { name: prompt.name })}
          testID={`saved-prompt-move-up-${prompt.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={t("settings.savedPrompts.actions.moveDown", { name: prompt.name })}
          testID={`saved-prompt-move-down-${prompt.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editIcon}
          onPress={handleEdit}
          accessibilityLabel={t("settings.savedPrompts.actions.edit", { name: prompt.name })}
          testID={`saved-prompt-edit-${prompt.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeIcon}
          onPress={handleRemove}
          accessibilityLabel={t("settings.savedPrompts.actions.remove", { name: prompt.name })}
          testID={`saved-prompt-remove-${prompt.id}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 60,
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  dragging: {
    backgroundColor: theme.colors.surface2,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
  },
}));
