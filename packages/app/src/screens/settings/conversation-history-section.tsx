/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ConversationHistoryProviderId,
  ConversationHistorySettings,
} from "@getpaseo/protocol/conversation-history/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { SettingsSection } from "./settings-section";

const PROVIDERS: ConversationHistoryProviderId[] = ["claude", "codex", "pi", "omp"];

export function ConversationHistorySettingsSection({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.conversationHistory === true,
  );
  const [settings, setSettings] = useState<ConversationHistorySettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !connected || !supported) return;
    try {
      setSettings(await client.getConversationHistorySettings());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, connected, supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!settings?.enabled) return;
    const timer = setInterval(() => void refresh(), 1_500);
    return () => clearInterval(timer);
  }, [refresh, settings?.enabled]);

  const update = useCallback(
    async (enabled: boolean, providers: ConversationHistoryProviderId[]) => {
      if (!client) return;
      setPending(true);
      setError(null);
      try {
        setSettings(await client.setConversationHistorySettings(enabled, providers));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [client],
  );

  const disable = useCallback(async () => {
    if (
      !settings ||
      !(await confirmDialog({
        title: "Disable Conversation history?",
        message:
          "This stops scanning and deletes Paseo's complete derived index. Provider files are not changed.",
        confirmLabel: "Disable and delete",
        destructive: true,
      }))
    )
      return;
    await update(false, []);
  }, [settings, update]);

  const clear = useCallback(async () => {
    if (
      !client ||
      !(await confirmDialog({
        title: "Clear History index?",
        message: "This deletes Paseo's derived copy without changing Provider files.",
        confirmLabel: "Clear index",
        destructive: true,
      }))
    )
      return;
    setPending(true);
    try {
      await client.clearConversationHistory();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [client, refresh]);

  const rescan = useCallback(async () => {
    if (!client) return;
    setPending(true);
    try {
      await client.rescanConversationHistory();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [client, refresh]);

  let content = <Text style={styles.detail}>Loading…</Text>;
  if (!supported) {
    content = (
      <Text style={styles.detail}>Update this Host to configure Conversation history.</Text>
    );
  } else if (!connected) {
    content = <Text style={styles.detail}>Reconnect to configure Conversation history.</Text>;
  } else if (settings) {
    content = (
      <HistorySettingsControls
        settings={settings}
        pending={pending}
        update={update}
        disable={disable}
        clear={clear}
        rescan={rescan}
      />
    );
  }

  return (
    <SettingsSection title="Conversation history">
      <View style={[settingsStyles.card, styles.card]} testID="conversation-history-settings">
        {content}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </SettingsSection>
  );
}

function HistorySettingsControls({
  settings,
  pending,
  update,
  disable,
  clear,
  rescan,
}: {
  settings: ConversationHistorySettings;
  pending: boolean;
  update: (enabled: boolean, providers: ConversationHistoryProviderId[]) => Promise<void>;
  disable: () => Promise<void>;
  clear: () => Promise<void>;
  rescan: () => Promise<void>;
}) {
  const [draftProviders, setDraftProviders] = useState<ConversationHistoryProviderId[]>(
    settings.providers,
  );
  useEffect(() => {
    if (settings.enabled || settings.providers.length > 0) setDraftProviders(settings.providers);
  }, [settings.enabled, settings.providers]);
  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        if (draftProviders.length === 0) return;
        const confirmed = await confirmDialog({
          title: "Enable Conversation history?",
          message:
            "The Daemon will scan the selected Claude, Codex, Pi, and OMP sources. Searchable derived content is copied under PASEO_HOME and can be read by every authenticated client of this Host. This feature does not upload history or expose it to Agents, MCP, or the CLI.",
          confirmLabel: "Enable and scan",
        });
        if (confirmed) await update(true, draftProviders);
      } else {
        await disable();
      }
    },
    [disable, draftProviders, update],
  );

  return (
    <>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.label}>{settings.enabled ? "Enabled" : "Disabled"}</Text>
          <Text style={styles.detail}>
            Searchable derived data stays under this Host&apos;s PASEO_HOME.
          </Text>
          <Text style={styles.detail}>OpenCode and generic ACP history are unsupported.</Text>
        </View>
        <Switch
          value={settings.enabled}
          onValueChange={toggleEnabled}
          disabled={pending || (!settings.enabled && draftProviders.length === 0)}
        />
      </View>
      {PROVIDERS.map((provider) => {
        const status = settings.providersStatus.find((item) => item.provider === provider);
        const selectedProviders = settings.enabled ? settings.providers : draftProviders;
        const checked = selectedProviders.includes(provider);
        return (
          <View key={provider} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.label}>
                {provider === "omp" ? "OMP" : provider.charAt(0).toUpperCase() + provider.slice(1)}
              </Text>
              <Text style={styles.detail}>
                {status?.sourceDescription ?? "Provider history"} · {status?.state ?? "disabled"} ·{" "}
                {status?.scannedConversations ?? 0}/{status?.totalConversations ?? "?"}{" "}
                conversations · {status?.staleCount ?? 0} stale · {status?.failureCount ?? 0}{" "}
                failures
              </Text>
              <Text style={styles.detail}>
                Last successful sync: {formatSyncTime(status?.lastSuccessfulSyncAt ?? null)}
              </Text>
            </View>
            <Switch
              value={checked}
              onValueChange={(value) => {
                const providers = value
                  ? [...selectedProviders, provider]
                  : selectedProviders.filter((item) => item !== provider);
                if (settings.enabled) void update(true, providers);
                else setDraftProviders(providers);
              }}
              disabled={pending}
            />
          </View>
        );
      })}
      {settings.enabled ? (
        <>
          <Text selectable style={styles.path}>
            {settings.indexPath}
          </Text>
          <View style={styles.actions}>
            <Button size="sm" variant="secondary" onPress={rescan} disabled={pending}>
              Rescan
            </Button>
            <Button size="sm" variant="secondary" onPress={clear} disabled={pending}>
              Clear index
            </Button>
            <Button size="sm" variant="destructive" onPress={disable} disabled={pending}>
              Disable and delete
            </Button>
          </View>
        </>
      ) : null}
    </>
  );
}

function formatSyncTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowText: { flex: 1, gap: theme.spacing[1] },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  path: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
