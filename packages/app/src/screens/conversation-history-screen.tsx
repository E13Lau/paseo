/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop */
import * as Clipboard from "expo-clipboard";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Check, ChevronDown, ChevronRight, Copy, Search } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ConversationHistoryConversation,
  ConversationHistoryEvent,
  ConversationHistoryProviderId,
  ConversationHistorySettings,
} from "@getpaseo/protocol/conversation-history/rpc-schemas";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/hooks/use-projects";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const PROVIDERS: ConversationHistoryProviderId[] = ["claude", "codex", "pi", "omp"];

type BrowsePayload = Awaited<
  ReturnType<NonNullable<ReturnType<typeof useHostRuntimeClient>>["browseConversationHistory"]>
>;
interface DetailState {
  conversation: ConversationHistoryConversation;
  events: ConversationHistoryEvent[];
  nextCursor: string | null;
  highlightedEventId: string | null;
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSearch = withUnistyles(Search, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export function ConversationHistoryScreen(): ReactElement {
  const serverId = useHostRouteServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.conversationHistory === true,
  );

  let content: ReactElement;
  if (!serverId || !supported) {
    content = (
      <StateCard
        title="Update this Host"
        detail="Conversation history requires a newer Paseo Daemon."
      />
    );
  } else if (!connected || !client) {
    content = (
      <StateCard
        title="Host unavailable"
        detail="Reconnect to this Host to browse its Conversation history. No offline copy is kept on this device."
      />
    );
  } else {
    content = <HistoryConnected serverId={serverId} client={client} />;
  }

  return (
    <View style={styles.screen}>
      <BackHeader title="History" />
      {content}
    </View>
  );
}

function HistoryConnected({
  serverId,
  client,
}: {
  serverId: string;
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
}) {
  const [settings, setSettings] = useState<ConversationHistorySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshSettings = useCallback(async () => {
    try {
      const value = await client.getConversationHistorySettings();
      setSettings(value);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  useEffect(() => {
    if (!settings?.enabled) return;
    const timer = setInterval(() => void refreshSettings(), 1_500);
    return () => clearInterval(timer);
  }, [refreshSettings, settings?.enabled]);

  if (loadError) {
    return (
      <StateCard
        title="History unavailable"
        detail={loadError}
        action="Retry"
        onAction={refreshSettings}
      />
    );
  }
  if (!settings) {
    return <LoadingState />;
  }
  if (settings.unavailableReason) {
    return <StateCard title="History unavailable" detail={settings.unavailableReason} />;
  }
  if (!settings.enabled) {
    return <EnableHistory client={client} settings={settings} onEnabled={setSettings} />;
  }
  return <HistoryBrowser serverId={serverId} client={client} settings={settings} />;
}

function EnableHistory({
  client,
  settings,
  onEnabled,
}: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  settings: ConversationHistorySettings;
  onEnabled: (settings: ConversationHistorySettings) => void;
}) {
  const [selected, setSelected] = useState<ConversationHistoryProviderId[]>(settings.providers);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = useCallback((provider: ConversationHistoryProviderId) => {
    setSelected((value) =>
      value.includes(provider) ? value.filter((item) => item !== provider) : [...value, provider],
    );
  }, []);
  const enable = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      onEnabled(await client.setConversationHistorySettings(true, selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [client, onEnabled, selected]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.consentCard} testID="history-disabled-state">
        <Text style={styles.title}>Enable Conversation history</Text>
        <Text style={styles.detail}>
          The Daemon will read the selected Provider histories and copy searchable derived content
          to:
        </Text>
        <Text selectable style={styles.mono}>
          {settings.indexPath}
        </Text>
        <Text style={styles.detail}>
          Every authenticated client of this Host can read the index. This feature does not upload
          history and does not expose it to Agents, MCP, or the CLI.
        </Text>
        <Text style={styles.detail}>
          OpenCode and generic ACP Providers are not supported and will not be scanned.
        </Text>
        <Text style={styles.label}>Providers to scan</Text>
        <View style={styles.providerGrid}>
          {PROVIDERS.map((provider) => {
            const status = settings.providersStatus.find((item) => item.provider === provider);
            return (
              <Pressable
                key={provider}
                onPress={() => toggle(provider)}
                style={[styles.choice, selected.includes(provider) && styles.choiceSelected]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected.includes(provider) }}
              >
                <View style={styles.checkSlot}>
                  {selected.includes(provider) ? <Check size={14} /> : null}
                </View>
                <View style={styles.choiceBody}>
                  <Text style={styles.choiceText}>{providerLabel(provider)}</Text>
                  <Text style={styles.choiceDetail}>{status?.sourceDescription}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button
          onPress={enable}
          loading={pending}
          disabled={pending || selected.length === 0}
          testID="history-enable-scan"
        >
          Enable and scan
        </Button>
      </View>
    </ScrollView>
  );
}

function HistoryBrowser({
  serverId,
  client,
  settings,
}: {
  serverId: string;
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  settings: ConversationHistorySettings;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ConversationHistoryProviderId | null>(null);
  const [role, setRole] = useState<"user" | "assistant" | null>(null);
  const [hasTools, setHasTools] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [projectId, setProjectId] = useState<string | null | undefined>(undefined);
  const [conversations, setConversations] = useState<ConversationHistoryConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const { projects: allProjects } = useProjects();
  const scanVersion = settings.providersStatus
    .map((item) => `${item.provider}:${item.state}:${item.scannedConversations}`)
    .join("|");

  const load = useCallback(
    async (cursor?: string, append = false) => {
      void scanVersion;
      setLoading(true);
      setError(null);
      try {
        const result: BrowsePayload = await client.browseConversationHistory({
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(provider ? { providers: [provider] } : {}),
          ...(role ? { role } : {}),
          ...(hasTools ? { hasTools: true } : {}),
          ...(from && !Number.isNaN(Date.parse(from))
            ? { from: new Date(from).toISOString() }
            : {}),
          ...(to && !Number.isNaN(Date.parse(to)) ? { to: new Date(to).toISOString() } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        setConversations((current) =>
          append ? [...current, ...result.conversations] : result.conversations,
        );
        setNextCursor(result.nextCursor);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (cursor && message.includes("cursor_expired")) void load(undefined, false);
        else setError(message);
      } finally {
        setLoading(false);
      }
    },
    [client, from, hasTools, projectId, provider, query, role, scanVersion, to],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of allProjects) {
      for (const host of project.hosts) {
        if (host.serverId === serverId)
          map.set(host.projectId, host.projectCustomName ?? host.projectName);
      }
    }
    return Array.from(map.entries());
  }, [allProjects, serverId]);

  const openDetail = useCallback(
    async (conversationId: string, highlightedEventId: string | null = null) => {
      setLoading(true);
      try {
        const result = await client.getConversationHistoryDetail(
          conversationId,
          highlightedEventId ? { eventId: highlightedEventId } : {},
        );
        setDetail({ ...result, highlightedEventId });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  if (detail)
    return (
      <HistoryDetail
        client={client}
        value={detail}
        onChange={setDetail}
        onBack={() => setDetail(null)}
      />
    );

  const scanning = settings.providersStatus.some(
    (item) => item.enabled && item.state === "scanning",
  );
  const providerFailed = settings.providersStatus.some(
    (item) => item.enabled && item.state === "failed",
  );
  const filtered = Boolean(
    query || provider || role || hasTools || projectId !== undefined || from || to,
  );
  let emptyTitle = "No conversations indexed";
  let emptyDetail = "Try enabling another Provider or rescan from Host settings.";
  if (filtered) emptyTitle = "No matching conversations";
  else if (providerFailed) {
    emptyTitle = "Provider scan failed";
    emptyDetail =
      "Other Providers remain available. Check Provider status or rescan from Host settings.";
  } else if (scanning) {
    emptyTitle = "Scanning Conversation history";
    emptyDetail = "Committed conversations will appear here while the first scan continues.";
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {scanning ? (
        <View style={styles.scanBanner}>
          <ThemedActivityIndicator size="small" />
          <Text style={styles.detail}>
            Scanning in the background. Committed results are available now.
          </Text>
        </View>
      ) : null}
      <View style={styles.searchBox}>
        <ThemedSearch size={16} />
        <ThemedTextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search user and Assistant text"
          style={styles.searchInput}
          testID="history-search-input"
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        <FilterChip label="All providers" selected={!provider} onPress={() => setProvider(null)} />
        {settings.providers.map((item) => (
          <FilterChip
            key={item}
            label={providerLabel(item)}
            selected={provider === item}
            onPress={() => setProvider(provider === item ? null : item)}
          />
        ))}
        <FilterChip
          label="User"
          selected={role === "user"}
          onPress={() => setRole(role === "user" ? null : "user")}
        />
        <FilterChip
          label="Assistant"
          selected={role === "assistant"}
          onPress={() => setRole(role === "assistant" ? null : "assistant")}
        />
        <FilterChip label="Has tools" selected={hasTools} onPress={() => setHasTools(!hasTools)} />
        <FilterChip
          label="Unassigned"
          selected={projectId === null}
          onPress={() => setProjectId(projectId === null ? undefined : null)}
        />
        {projects.map(([id, name]) => (
          <FilterChip
            key={id}
            label={name}
            selected={projectId === id}
            onPress={() => setProjectId(projectId === id ? undefined : id)}
          />
        ))}
      </ScrollView>
      <View style={styles.timeFilters}>
        <ThemedTextInput
          value={from}
          onChangeText={setFrom}
          placeholder="From date (YYYY-MM-DD)"
          style={styles.timeInput}
        />
        <ThemedTextInput
          value={to}
          onChangeText={setTo}
          placeholder="To date (YYYY-MM-DD)"
          style={styles.timeInput}
        />
      </View>
      {error ? (
        <StateCard
          title="History could not be loaded"
          detail={error}
          action="Retry"
          onAction={() => load()}
        />
      ) : null}
      {!error && !loading && conversations.length === 0 ? (
        <StateCard title={emptyTitle} detail={emptyDetail} />
      ) : null}
      <View style={styles.list}>
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.conversationId}
            conversation={conversation}
            onOpen={openDetail}
          />
        ))}
      </View>
      {loading ? <LoadingState compact /> : null}
      {nextCursor && !loading ? (
        <Button variant="secondary" onPress={() => load(nextCursor, true)}>
          Load more
        </Button>
      ) : null}
    </ScrollView>
  );
}

function ConversationRow({
  conversation,
  onOpen,
}: {
  conversation: ConversationHistoryConversation;
  onOpen: (id: string, eventId?: string | null) => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => onOpen(conversation.conversationId)}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {conversation.title}
          </Text>
          <ChevronRight size={16} />
        </View>
        <Text style={styles.meta}>
          {providerLabel(conversation.provider)} · {conversation.projectName ?? "Unassigned"} ·{" "}
          {formatTime(conversation.lastActivityAt)}
          {conversation.stale ? " · Stale" : ""}
        </Text>
      </Pressable>
      {conversation.snippets?.map((snippet) => (
        <View key={snippet.eventId} style={styles.snippet}>
          <Pressable
            onPress={() => onOpen(conversation.conversationId, snippet.eventId)}
            style={styles.snippetContent}
          >
            <Text style={styles.snippetRole}>
              {snippet.role} · {formatTime(snippet.timestamp)}
            </Text>
            <Text selectable numberOfLines={3} style={styles.snippetText}>
              {snippet.text}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void Clipboard.setStringAsync(snippet.text)}
            hitSlop={8}
            accessibilityLabel="Copy snippet"
          >
            <Copy size={14} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function HistoryDetail({
  client,
  value,
  onChange,
  onBack,
}: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  value: DetailState;
  onChange: (value: DetailState) => void;
  onBack: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMore = useCallback(async () => {
    if (!value.nextCursor) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getConversationHistoryDetail(value.conversation.conversationId, {
        cursor: value.nextCursor,
      });
      onChange({
        ...value,
        events: [...value.events, ...result.events],
        nextCursor: result.nextCursor,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("cursor_expired")) {
        const result = await client.getConversationHistoryDetail(
          value.conversation.conversationId,
          value.highlightedEventId ? { eventId: value.highlightedEventId } : {},
        );
        onChange({ ...result, highlightedEventId: value.highlightedEventId });
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [client, onChange, value]);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Button variant="ghost" size="sm" onPress={onBack}>
        Back to results
      </Button>
      <Text style={styles.title}>{value.conversation.title}</Text>
      <Text style={styles.meta}>
        {providerLabel(value.conversation.provider)} ·{" "}
        {value.conversation.projectName ?? "Unassigned"}
      </Text>
      <View style={styles.timeline}>
        {value.events.map((event) => (
          <HistoryEventRow
            key={event.eventId}
            event={event}
            highlighted={value.highlightedEventId === event.eventId}
            expanded={expanded.has(event.eventId)}
            setExpanded={setExpanded}
          />
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {value.nextCursor ? (
        <Button variant="secondary" loading={loading} onPress={loadMore}>
          Load more messages
        </Button>
      ) : null}
    </ScrollView>
  );
}

function HistoryEventRow({
  event,
  highlighted,
  expanded,
  setExpanded,
}: {
  event: ConversationHistoryEvent;
  highlighted: boolean;
  expanded: boolean;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
}) {
  const collapsed = event.role === "tool" || event.role === "reasoning_summary";
  const copy = useCallback(() => {
    if (event.text) void Clipboard.setStringAsync(event.text);
  }, [event.text]);
  const toggle = useCallback(() => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(event.eventId)) next.delete(event.eventId);
      else next.add(event.eventId);
      return next;
    });
  }, [event.eventId, setExpanded]);

  let body: ReactElement | null = null;
  if (collapsed && expanded) {
    const text =
      event.role === "reasoning_summary"
        ? event.text
        : (event.toolInput ?? event.toolResult ?? "No stored detail");
    body = (
      <Text selectable style={styles.mono}>
        {text}
      </Text>
    );
  } else if (event.role === "attachment") {
    body = (
      <Text selectable style={styles.eventText}>
        {[event.attachmentName, event.attachmentMime, event.text].filter(Boolean).join(" · ")}
      </Text>
    );
  } else if (!collapsed && event.text) {
    body = (
      <Text selectable style={styles.eventText}>
        {event.text}
      </Text>
    );
  }

  return (
    <View style={[styles.event, highlighted && styles.eventHighlighted]}>
      <View style={styles.eventHeader}>
        <Text style={styles.snippetRole}>
          {eventLabel(event)} · {formatTime(event.timestamp)}
        </Text>
        {event.text ? (
          <Pressable onPress={copy} hitSlop={8} accessibilityLabel="Copy message">
            <Copy size={14} />
          </Pressable>
        ) : null}
      </View>
      {collapsed ? (
        <Pressable onPress={toggle} style={styles.toolToggle}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Text style={styles.detail}>
            {event.role === "reasoning_summary" ? "Collapsed" : (event.toolStatus ?? "Recorded")}
            {event.truncated ? ` · truncated from ${event.originalSize ?? 0} bytes` : ""}
          </Text>
        </Pressable>
      ) : null}
      {body}
    </View>
  );
}

function eventLabel(event: ConversationHistoryEvent): string {
  if (event.role === "tool") return event.toolName ?? "Tool";
  if (event.role === "reasoning_summary") return "Reasoning summary";
  return event.role;
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.filterChip, selected && styles.filterChipSelected]}>
      <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{label}</Text>
    </Pressable>
  );
}
function LoadingState({ compact = false }: { compact?: boolean }) {
  return (
    <View style={compact ? styles.loadingCompact : styles.loading}>
      <ActivityIndicator />
      <Text style={styles.detail}>Loading History…</Text>
    </View>
  );
}
function StateCard({
  title,
  detail,
  action,
  onAction,
}: {
  title: string;
  detail: string;
  action?: string;
  onAction?: () => void | Promise<void>;
}) {
  return (
    <View style={styles.stateCard}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.detail}>{detail}</Text>
      {action && onAction ? (
        <Button variant="secondary" onPress={onAction}>
          {action}
        </Button>
      ) : null}
    </View>
  );
}
function providerLabel(provider: ConversationHistoryProviderId): string {
  return provider === "omp" ? "OMP" : provider.charAt(0).toUpperCase() + provider.slice(1);
}
function formatTime(value: string | null): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[2] },
  loadingCompact: { padding: theme.spacing[4], alignItems: "center", gap: theme.spacing[2] },
  stateCard: {
    margin: theme.spacing[4],
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  consentCard: {
    padding: theme.spacing[6],
    gap: theme.spacing[4],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  mono: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  providerGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  choice: {
    minWidth: 130,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  choiceSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  checkSlot: { width: 16 },
  choiceBody: { flex: 1, gap: theme.spacing[1] },
  choiceText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  choiceDetail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  scanBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  filters: { gap: theme.spacing[2] },
  timeFilters: { flexDirection: "row", gap: theme.spacing[2] },
  timeInput: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  filterChip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  filterChipSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  filterText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  filterTextSelected: { color: theme.colors.accentForeground },
  list: { gap: theme.spacing[2] },
  row: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  snippet: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  snippetContent: { flex: 1, gap: theme.spacing[1] },
  snippetRole: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  snippetText: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  timeline: { gap: theme.spacing[3] },
  event: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  eventHighlighted: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  eventHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eventText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, lineHeight: 21 },
  toolToggle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
}));
