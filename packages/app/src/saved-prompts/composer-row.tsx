import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ScrollView,
  StyleSheet as RNStyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, MessageSquareText } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { buttonIconSize } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { SPACING, type Theme } from "@/styles/theme";
import type { SavedPrompt } from "./model";

const REVEAL_DURATION_MS = 160;
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);

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

interface SavedPromptComposerRowProps {
  prompts: readonly SavedPrompt[];
  automaticSending: boolean;
  canAutomaticSend: boolean;
  onPrepareSelect: () => void;
  onSelect: (prompt: SavedPrompt) => void;
  onRequestComposerFocus: () => void;
}

export function SavedPromptComposerRow({
  prompts,
  automaticSending,
  canAutomaticSend,
  onPrepareSelect,
  onSelect,
  onRequestComposerFocus,
}: SavedPromptComposerRowProps): ReactElement | null {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const shouldFocusFirstRef = useRef(false);
  const revealProgress = useSharedValue(0);
  const contentStyle = useMemo(
    () => [laneStyles.content, compact ? laneStyles.contentCompact : null],
    [compact],
  );
  const triggerLabel = t("settings.sections.savedPrompts");
  const triggerSize = compact ? "md" : "xs";
  const promptDisabled = automaticSending && !canAutomaticSend;
  const triggerAccessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const triggerWebProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const expandedChevron = useMemo(
    () => <ThemedChevronLeft size={buttonIconSize[triggerSize]} uniProps={foregroundIconMapping} />,
    [triggerSize],
  );
  const collapsedChevron = useMemo(
    () => (
      <ThemedChevronRight size={buttonIconSize[triggerSize]} uniProps={foregroundIconMapping} />
    ),
    [triggerSize],
  );

  const collapseAndRestoreFocus = useCallback(() => {
    setExpanded(false);
    onRequestComposerFocus();
  }, [onRequestComposerFocus]);

  const handleSelect = useCallback(
    (prompt: SavedPrompt) => {
      setExpanded(false);
      onSelect(prompt);
    },
    [onSelect],
  );

  const handleTriggerPressIn = useCallback((event: GestureResponderEvent) => {
    if (isWeb) {
      event.preventDefault();
    }
  }, []);

  const handleTriggerPress = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  useEffect(() => {
    if (!isWeb) return;
    const root = globalThis.document;
    if (!root) return;

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const trigger = root.querySelector('[data-testid="saved-prompts-composer-trigger"]');
      if (event.key === "Escape" && expanded) {
        event.preventDefault();
        event.stopPropagation();
        collapseAndRestoreFocus();
        return;
      }
      if (
        (event.key === "Enter" || event.key === " " || event.key === "Spacebar") &&
        target instanceof Element &&
        trigger?.contains(target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setExpanded((current) => {
          const next = !current;
          shouldFocusFirstRef.current = next;
          return next;
        });
      }
    };

    root.addEventListener("keydown", handleWindowKeyDown, true);
    return () => root.removeEventListener("keydown", handleWindowKeyDown, true);
  }, [collapseAndRestoreFocus, expanded]);

  useEffect(() => {
    revealProgress.value = withTiming(expanded ? 1 : 0, {
      duration: reduceMotion ? 0 : REVEAL_DURATION_MS,
    });
  }, [expanded, reduceMotion, revealProgress]);

  useEffect(() => {
    if (!expanded || !shouldFocusFirstRef.current || prompts.length === 0) {
      return;
    }
    if (!isWeb) return;
    shouldFocusFirstRef.current = false;
    const firstId = prompts[0]?.id;
    if (!firstId) return;
    const frame = requestAnimationFrame(() => {
      const element = globalThis.document.querySelector(
        `[data-testid="saved-prompt-composer-${firstId}"]`,
      );
      if (element && "focus" in element && typeof element.focus === "function") {
        element.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, prompts]);

  const laneStyle = useAnimatedStyle(() => ({
    maxWidth: `${revealProgress.value * 100}%`,
    opacity: revealProgress.value,
  }));

  if (prompts.length === 0) {
    return null;
  }

  return (
    <View style={styles.row} testID="saved-prompts-composer-row">
      <Button
        variant="secondary"
        size={triggerSize}
        leftIcon={MessageSquareText}
        trailing={expanded ? expandedChevron : collapsedChevron}
        onPressIn={handleTriggerPressIn}
        onPress={handleTriggerPress}
        accessibilityLabel={triggerLabel}
        accessibilityState={triggerAccessibilityState}
        testID="saved-prompts-composer-trigger"
        {...triggerWebProps}
      >
        {compact ? null : triggerLabel}
      </Button>
      <Animated.View
        style={[
          laneStyles.lane,
          expanded ? laneStyles.laneExpanded : laneStyles.laneCollapsed,
          laneStyle,
        ]}
        pointerEvents={expanded ? "auto" : "none"}
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
      >
        {expanded ? (
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
                disabled={promptDisabled}
                onSelect={handleSelect}
              />
            ))}
          </ScrollView>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
}));

const laneStyles = RNStyleSheet.create({
  lane: {
    minWidth: 0,
    overflow: "hidden",
  },
  laneExpanded: {
    flexGrow: 1,
    flexShrink: 1,
  },
  laneCollapsed: {
    flexGrow: 0,
    flexShrink: 0,
    maxWidth: 0,
  },
  content: {
    flexDirection: "row",
    gap: SPACING[2],
    paddingRight: SPACING[2],
  },
  contentCompact: {
    gap: SPACING[3],
  },
});
