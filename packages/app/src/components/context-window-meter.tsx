import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChartPie } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { matchProvider, ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { providerUsageCopy } from "@/provider-usage/copy";
import type { ProviderUsageView } from "@/provider-usage/types";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { formatTokenCount } from "./context-window-meter.utils";

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function getMeterColors(
  percentage: number,
  theme: ReturnType<typeof useUnistyles>["theme"],
): { progress: string; track: string } {
  const track = theme.colors.surface3;
  if (percentage > 90) {
    return { progress: theme.colors.destructive, track };
  }
  if (percentage >= 70) {
    return { progress: theme.colors.palette.amber[500], track };
  }
  return { progress: theme.colors.foregroundMuted, track };
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

function hasUsablePlanUsage(
  view: ProviderUsageView,
  activeProviderId: string | null | undefined,
): boolean {
  if (view.kind === "loading" || view.kind === "error") {
    return true;
  }
  return matchProvider(view.payload.providers, activeProviderId) !== null;
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  serverId,
  provider,
  glyphSize,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen },
  );
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen) {
        void refreshProviderUsage().catch(() => {});
      }
    },
    [refreshProviderUsage],
  );

  const geometry = getMeterGeometry(showPercentage, glyphSize);
  const hasContextPercentage = percentage !== null && maxTokens !== null && usedTokens !== null;
  const showEmptyState = !hasContextPercentage && !hasUsablePlanUsage(providerUsageView, provider);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;

  let triggerContent: ReactElement;
  if (hasContextPercentage) {
    triggerContent = (
      <KnownContextGlyph
        colors={getMeterColors(clampPercentage(percentage), theme)}
        geometry={geometry}
        percentage={percentage}
        showPercentage={showPercentage}
      />
    );
  } else {
    triggerContent = <ChartPie size={geometry.svgSize} color={theme.colors.foregroundMuted} />;
  }

  const accessibilityLabel = hasContextPercentage
    ? t("contextWindow.accessibility", { percentage: Math.round(percentage) })
    : t("contextWindow.usageAccessibility");

  return (
    <Tooltip
      open={isTooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      delayDuration={0}
      enabledOnDesktop
      enabledOnMobile
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={geometry.containerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={accessibilityLabel}
        >
          {triggerContent}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipContent}>
          {showEmptyState ? (
            <Text style={styles.tooltipText}>{providerUsageCopy.empty}</Text>
          ) : (
            <>
              <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
              {hasContextPercentage ? (
                <>
                  <Text style={styles.tooltipText}>
                    {t("contextWindow.used", { percentage: Math.round(percentage) })}
                  </Text>
                  <Text style={styles.tooltipDetail}>
                    {t("contextWindow.tokens", {
                      used: formatTokenCount(usedTokens),
                      max: formatTokenCount(maxTokens),
                    })}
                  </Text>
                  {formattedSessionCost ? (
                    <Text style={styles.tooltipDetail}>
                      {t("contextWindow.sessionCost", { cost: formattedSessionCost })}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text style={styles.tooltipText}>{t("contextWindow.unknown")}</Text>
              )}
              <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
            </>
          )}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

function KnownContextGlyph({
  colors,
  geometry,
  percentage,
  showPercentage,
}: {
  colors: { progress: string; track: string };
  geometry: ReturnType<typeof getMeterGeometry>;
  percentage: number;
  showPercentage: boolean;
}) {
  const clampedPercentage = clampPercentage(percentage);
  const roundedPercentage = Math.round(percentage);
  const { svgSize, center, radius, strokeWidth, circumference } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;

  return (
    <>
      <Svg
        width={svgSize}
        height={svgSize}
        viewBox={`0 0 ${svgSize} ${svgSize}`}
        style={styles.svg}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.track}
          strokeWidth={strokeWidth}
        />
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.progress}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </Svg>
      {showPercentage ? (
        <Text style={styles.percentageLabel}>{`${roundedPercentage}%`}</Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipContent: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
