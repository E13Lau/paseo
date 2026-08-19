import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  createPortForward,
  listPortForwards,
  openPortForward,
  retryPortForward,
  stopPortForward,
  subscribePortForwards,
  updatePortForward,
  type PortForwardSnapshot,
} from "@/desktop/port-forward/facade";
import { resolvePortForwardCapability } from "./capability";
import { openPortForwardForm, type PortForwardFormModel } from "./form-model";
import { consumeForwardPortShortcut } from "./shortcut";

export { openForwardPortShortcut } from "./shortcut";

export function PortsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [forwards, setForwards] = useState<PortForwardSnapshot[]>([]);
  const [form, setForm] = useState<{
    mode: "create" | "edit";
    id?: string;
    model: PortForwardFormModel;
    seed?: { target: string; label: string; openAs?: "none" | "http" | "https" };
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | "stop" | "retry" | null>(null);
  const pendingActionRef = useRef(false);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const feature = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.portForward,
  );
  const capability = resolvePortForwardCapability({
    serverId,
    isConnected,
    feature,
    hasRestoredForward: forwards.length > 0,
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      const items = await listPortForwards(serverId);
      if (active) setForwards(items.filter((item) => item.serverId === serverId));
    })();
    const unlisten = subscribePortForwards((items) => {
      setForwards(items.filter((item) => item.serverId === serverId));
    });
    return () => {
      active = false;
      void (async () => {
        const stop = await unlisten;
        stop();
      })();
    };
  }, [serverId]);

  const openCreate = useCallback(
    (seed?: { target: string; label: string; openAs?: "none" | "http" | "https" }) => {
      const model = openPortForwardForm({ mode: "create", capability });
      if (seed) {
        model.setTarget(seed.target);
        model.setLabel(seed.label);
        model.setOpenAs(seed.openAs ?? "http");
      }
      setForm({ mode: "create", model, seed });
      setActionError(null);
    },
    [capability],
  );

  useEffect(() => {
    return consumeForwardPortShortcut((input) => {
      if (input.serverId !== serverId) return;
      openCreate({ target: input.target, label: input.label, openAs: "http" });
    });
  }, [openCreate, serverId]);

  const formHeader = useMemo<SheetHeader>(
    () => ({
      title:
        form?.mode === "edit"
          ? t("settings.host.ports.editTitle")
          : t("settings.host.ports.addTitle"),
    }),
    [form?.mode, t],
  );

  const handleCopy = useCallback(
    async (forward: PortForwardSnapshot) => {
      if (!forward.localAddress) return;
      await Clipboard.setStringAsync(forward.localAddress);
      toast.copied();
    },
    [toast],
  );

  const handleOpen = useCallback(async (forward: PortForwardSnapshot) => {
    if (!forward.localAddress || forward.openAs === "none") return;
    const protocol = forward.openAs === "https" ? "https" : "http";
    await openPortForward(`${protocol}://${forward.localAddress}`);
  }, []);

  const handleStop = useCallback(
    async (id: string) => {
      if (pendingActionRef.current) return;
      pendingActionRef.current = true;
      setPendingAction("stop");
      setActionError(null);
      try {
        await stopPortForward(id);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : t("settings.host.ports.actionFailed"),
        );
      } finally {
        pendingActionRef.current = false;
        setPendingAction(null);
      }
    },
    [t],
  );

  const handleRetry = useCallback(
    async (id: string) => {
      if (pendingActionRef.current) return;
      pendingActionRef.current = true;
      setPendingAction("retry");
      setActionError(null);
      try {
        await retryPortForward(id);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : t("settings.host.ports.actionFailed"),
        );
      } finally {
        pendingActionRef.current = false;
        setPendingAction(null);
      }
    },
    [t],
  );

  const handleAdd = useCallback(() => {
    openCreate();
  }, [openCreate]);

  const handleCloseForm = useCallback(() => {
    form?.model.close();
    setForm(null);
  }, [form]);

  const handleSubmitForm = useCallback(async () => {
    if (!form || pendingActionRef.current) return;
    const state = form.model.getState();
    pendingActionRef.current = true;
    setPendingAction("save");
    setActionError(null);
    try {
      if (form.mode === "create") {
        await createPortForward({
          serverId,
          target: state.target,
          label: state.label,
          ...(state.localPort ? { localPort: Number(state.localPort) } : {}),
          requireLocalPort: state.requireLocalPort,
          openAs: state.openAs,
        });
      } else if (form.id) {
        await updatePortForward({
          id: form.id,
          target: state.target,
          label: state.label,
          ...(state.localPort ? { localPort: Number(state.localPort) } : {}),
          requireLocalPort: state.requireLocalPort,
          openAs: state.openAs,
        });
      }
      form.model.close();
      setForm(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t("settings.host.ports.actionFailed"),
      );
    } finally {
      pendingActionRef.current = false;
      setPendingAction(null);
    }
  }, [form, serverId, t]);

  return (
    <SettingsGroup title={t("settings.host.ports.title")} testID="host-ports-group">
      <SettingsSection title={t("settings.host.ports.sectionTitle")} flush>
        <View style={settingsStyles.card} testID="host-ports-card">
          <Text style={styles.hint} testID="host-ports-loopback-hint">
            {t("settings.host.ports.loopbackHint")}
          </Text>
          {capability === "unsupported" ? (
            <Text style={styles.hint} testID="host-ports-update-host">
              {t("settings.host.ports.updateHost")}
            </Text>
          ) : null}
          {capability === "unknown" ? (
            <Text style={styles.hint} testID="host-ports-unknown">
              {t("settings.host.ports.unknownCapability")}
            </Text>
          ) : null}
          {forwards.map((forward, index) => (
            <ForwardRow
              key={forward.id}
              forward={forward}
              showBorder={index > 0}
              capability={capability}
              onCopy={handleCopy}
              onOpen={handleOpen}
              onStop={handleStop}
              onRetry={handleRetry}
              onEdit={setForm}
              actionsDisabled={pendingAction !== null}
            />
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={capability !== "supported" || pendingAction !== null}
            testID="host-ports-add"
            onPress={handleAdd}
          >
            {t("settings.host.ports.add")}
          </Button>
          {actionError ? (
            <Text style={styles.error} testID="host-ports-error">
              {actionError}
            </Text>
          ) : null}
        </View>
      </SettingsSection>
      {form ? (
        <PortForwardFormSheet
          header={formHeader}
          model={form.model}
          pending={pendingAction === "save"}
          onClose={handleCloseForm}
          onSubmit={handleSubmitForm}
        />
      ) : null}
    </SettingsGroup>
  );
}

function PortForwardFormSheet({
  header,
  model,
  pending,
  onClose,
  onSubmit,
}: {
  header: SheetHeader;
  model: PortForwardFormModel;
  pending: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const openAsOptions = useMemo(
    () => [
      { value: "none" as const, label: t("settings.host.ports.openAsNone") },
      { value: "http" as const, label: "HTTP" },
      { value: "https" as const, label: "HTTPS" },
    ],
    [t],
  );
  const handleSubmit = useCallback(() => {
    void onSubmit();
  }, [onSubmit]);
  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="host-ports-form">
      <Field
        label={t("settings.host.ports.target")}
        error={state.targetError ? t("settings.host.ports.errors.target") : null}
      >
        <FormTextInput
          value={state.target}
          onChangeText={model.setTarget}
          placeholder="8080"
          testID="host-ports-target"
        />
      </Field>
      <Field label={t("settings.host.ports.label")}>
        <FormTextInput
          value={state.label}
          onChangeText={model.setLabel}
          testID="host-ports-label"
        />
      </Field>
      <Field
        label={t("settings.host.ports.localPort")}
        error={state.localPortError ? t("settings.host.ports.errors.port") : null}
      >
        <FormTextInput
          value={state.localPort}
          onChangeText={model.setLocalPort}
          placeholder={t("settings.host.ports.localPortPlaceholder")}
          testID="host-ports-local-port"
        />
      </Field>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t("settings.host.ports.requireLocalPort")}</Text>
        <Switch
          value={state.requireLocalPort}
          onValueChange={model.setRequireLocalPort}
          testID="host-ports-require-local"
        />
      </View>
      <Field label={t("settings.host.ports.openAs")}>
        <SegmentedControl
          value={state.openAs}
          onValueChange={model.setOpenAs}
          options={openAsOptions}
        />
      </Field>
      <Button
        disabled={!state.canSubmit || pending}
        testID="host-ports-submit"
        onPress={handleSubmit}
      >
        {t("settings.host.ports.save")}
      </Button>
    </AdaptiveModalSheet>
  );
}

function ForwardRow({
  forward,
  showBorder,
  capability,
  onCopy,
  onOpen,
  onStop,
  onRetry,
  onEdit,
  actionsDisabled,
}: {
  forward: PortForwardSnapshot;
  showBorder: boolean;
  capability: "supported" | "unsupported" | "unknown";
  onCopy: (forward: PortForwardSnapshot) => Promise<void>;
  onOpen: (forward: PortForwardSnapshot) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  actionsDisabled: boolean;
  onEdit: React.Dispatch<
    React.SetStateAction<{
      mode: "create" | "edit";
      id?: string;
      model: PortForwardFormModel;
      seed?: { target: string; label: string; openAs?: "none" | "http" | "https" };
    } | null>
  >;
}) {
  const { t } = useTranslation();
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder, styles.row],
    [showBorder],
  );
  const handleCopy = useCallback(() => {
    void onCopy(forward);
  }, [forward, onCopy]);
  const handleOpen = useCallback(() => {
    void onOpen(forward);
  }, [forward, onOpen]);
  const handleStop = useCallback(() => {
    void onStop(forward.id);
  }, [forward.id, onStop]);
  const handleRetry = useCallback(() => {
    void onRetry(forward.id);
  }, [forward.id, onRetry]);
  const handleEdit = useCallback(() => {
    const model = openPortForwardForm({
      mode: "edit",
      capability,
      record: {
        targetDisplay: forward.targetDisplay,
        label: forward.label,
        preferredLocalPort: forward.preferredLocalPort,
        requireLocalPort: forward.requireLocalPort,
        openAs: forward.openAs,
      },
    });
    onEdit({ mode: "edit", id: forward.id, model });
  }, [capability, forward, onEdit]);
  return (
    <View style={rowStyle} testID={`host-ports-row-${forward.id}`}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{forward.label || forward.targetDisplay}</Text>
        <Text style={styles.meta}>
          {forward.localAddress ?? t("settings.host.ports.noAddress")} ·{" "}
          {stateLabel(forward.state, t)}
        </Text>
        {forward.recentError ? (
          <Text style={styles.error}>
            {t("settings.host.ports.recentError", { category: forward.recentError.category })}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Pressable onPress={handleCopy} testID={`host-ports-copy-${forward.id}`}>
          <Text style={styles.action}>{t("settings.host.ports.copy")}</Text>
        </Pressable>
        {forward.openAs !== "none" ? (
          <Pressable onPress={handleOpen} testID={`host-ports-open-${forward.id}`}>
            <Text style={styles.action}>{t("settings.host.ports.open")}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={handleEdit} testID={`host-ports-edit-${forward.id}`}>
          <Text style={styles.action}>{t("settings.host.ports.edit")}</Text>
        </Pressable>
        {forward.state === "error" || forward.state === "port_unavailable" ? (
          <Pressable
            onPress={handleRetry}
            disabled={actionsDisabled}
            testID={`host-ports-retry-${forward.id}`}
          >
            <Text style={styles.action}>{t("settings.host.ports.retry")}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={handleStop}
          disabled={actionsDisabled}
          testID={`host-ports-stop-${forward.id}`}
        >
          <Text style={styles.action}>{t("settings.host.ports.stop")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function stateLabel(state: PortForwardSnapshot["state"], t: (key: string) => string): string {
  if (state === "starting") return t("settings.host.ports.states.starting");
  if (state === "waiting_for_host") return t("settings.host.ports.states.waiting");
  if (state === "update_host_required") return t("settings.host.ports.states.updateHost");
  if (state === "ready") return t("settings.host.ports.states.ready");
  if (state === "port_unavailable") return t("settings.host.ports.states.unavailable");
  return t("settings.host.ports.states.error");
}

const styles = StyleSheet.create((theme) => ({
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  row: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  action: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[3],
  },
  switchLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
