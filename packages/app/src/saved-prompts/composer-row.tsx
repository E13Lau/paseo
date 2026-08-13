import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { SavedPrompt } from "./model";

interface SavedPromptButtonProps {
  prompt: SavedPrompt;
  disabled: boolean;
  compact: boolean;
  onPrepareSelect: () => void;
  onSelect: (prompt: SavedPrompt) => void;
}

function SavedPromptButton({
  prompt,
  disabled,
  compact,
  onPrepareSelect,
  onSelect,
}: SavedPromptButtonProps): ReactElement {
  const handlePress = useCallback(() => onSelect(prompt), [onSelect, prompt]);
  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (isWeb) {
        event.preventDefault();
      }
      onPrepareSelect();
    },
    [onPrepareSelect],
  );
  return (
    <Button
      variant="secondary"
      size={compact ? "md" : "xs"}
      onPressIn={handlePressIn}
      onPress={handlePress}
      disabled={disabled}
      accessibilityLabel={prompt.name}
      testID={`saved-prompt-composer-${prompt.id}`}
    >
      {prompt.name}
    </Button>
  );
}

export function SavedPromptComposerRow({
  prompts,
  automaticSending,
  canAutomaticSend,
  pendingPromptId,
  onPrepareSelect,
  onSelect,
}: {
  prompts: readonly SavedPrompt[];
  automaticSending: boolean;
  canAutomaticSend: boolean;
  pendingPromptId: string | null;
  onPrepareSelect: () => void;
  onSelect: (prompt: SavedPrompt) => void;
}): ReactElement | null {
  const compact = useIsCompactFormFactor();
  const contentStyle = useMemo(
    () => [styles.content, compact ? styles.contentCompact : null],
    [compact],
  );

  if (prompts.length === 0) {
    return null;
  }

  return (
    <View style={styles.clip} testID="saved-prompts-composer-row">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={contentStyle}
      >
        {prompts.map((prompt) => (
          <SavedPromptButton
            key={prompt.id}
            prompt={prompt}
            compact={compact}
            onPrepareSelect={onPrepareSelect}
            disabled={automaticSending && (!canAutomaticSend || pendingPromptId === prompt.id)}
            onSelect={onSelect}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  clip: {
    minWidth: 0,
    overflow: "hidden",
  },
  content: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[2],
  },
  contentCompact: {
    gap: theme.spacing[3],
  },
}));
