import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type { InstructionFileListItem, InstructionFileVersion } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useInstructionFiles } from "./use-instruction-files";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface EditorState {
  file: InstructionFileListItem;
  draft: string;
  loadedText: string;
  version: InstructionFileVersion;
  loadError: string | null;
  saveError: string | null;
  conflict: InstructionFileVersion | null;
  saving: boolean;
  loading: boolean;
}

export function InstructionFilesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const files = useInstructionFiles(serverId);
  const refreshFiles = files.refresh;
  const getFile = files.getFile;
  const writeFile = files.writeFile;
  const filesConnected = files.connected;
  const filesSupported = files.supported;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const savingRef = useRef(false);
  const openGenerationRef = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (filesConnected && filesSupported) void refreshFiles();
      return undefined;
    }, [filesConnected, filesSupported, refreshFiles]),
  );

  const header = useMemo<SheetHeader>(
    () => ({ title: editor?.file.filename ?? t("settings.host.instructionFiles.sectionTitle") }),
    [editor?.file.filename, t],
  );
  const hasChanges = editor != null && editor.draft !== editor.loadedText && !editor.loading;
  const closeBlocked = editor?.saving === true;

  const handleClose = useCallback(() => {
    if (closeBlocked) return;
    openGenerationRef.current += 1;
    setEditor(null);
  }, [closeBlocked]);

  const handleOpen = useCallback(
    async (file: InstructionFileListItem) => {
      const generation = ++openGenerationRef.current;
      savingRef.current = false;
      setEditor({
        file,
        draft: "",
        loadedText: "",
        version: { status: "missing" },
        loadError: null,
        saveError: null,
        conflict: null,
        saving: false,
        loading: true,
      });
      try {
        const result = await getFile(file.id);
        if (openGenerationRef.current !== generation) return;
        if (result.status === "error") {
          setEditor({
            file,
            draft: "",
            loadedText: "",
            version: { status: "missing" },
            loadError: result.error,
            saveError: null,
            conflict: null,
            saving: false,
            loading: false,
          });
          return;
        }
        setEditor({
          file,
          draft: result.text,
          loadedText: result.text,
          version: result.version,
          loadError: null,
          saveError: null,
          conflict: null,
          saving: false,
          loading: false,
        });
      } catch (error) {
        if (openGenerationRef.current !== generation) return;
        setEditor({
          file,
          draft: "",
          loadedText: "",
          version: { status: "missing" },
          loadError: error instanceof Error ? error.message : String(error),
          saveError: null,
          conflict: null,
          saving: false,
          loading: false,
        });
      }
    },
    [getFile],
  );

  const handleDraftChange = useCallback((text: string) => {
    setEditor((current) =>
      current && !current.saving && !current.loading ? { ...current, draft: text } : current,
    );
  }, []);

  const handleReset = useCallback(() => {
    setEditor((current) =>
      current && !current.saving ? { ...current, draft: current.loadedText } : current,
    );
  }, []);

  const handleSave = useCallback(
    async (version: InstructionFileVersion) => {
      if (!editor || editor.loading || savingRef.current) return;
      savingRef.current = true;
      setEditor((current) =>
        current ? { ...current, saving: true, saveError: null, conflict: null } : current,
      );
      try {
        const result = await writeFile({
          id: editor.file.id,
          text: editor.draft,
          expectedModifiedAt: version.status === "present" ? version.modifiedAt : undefined,
          expectedRevision: version.status === "present" ? version.revision : undefined,
        });
        if (result.status === "conflict") {
          setEditor((current) =>
            current
              ? { ...current, saving: false, conflict: result.version, saveError: null }
              : current,
          );
          return;
        }
        if (result.status === "error") {
          setEditor((current) =>
            current ? { ...current, saving: false, saveError: result.error } : current,
          );
          return;
        }
        setEditor(null);
        await refreshFiles();
      } catch (error) {
        setEditor((current) =>
          current
            ? {
                ...current,
                saving: false,
                saveError: error instanceof Error ? error.message : String(error),
              }
            : current,
        );
      } finally {
        savingRef.current = false;
      }
    },
    [editor, refreshFiles, writeFile],
  );

  const handleReload = useCallback(async () => {
    if (!editor || editor.saving) return;
    await handleOpen(editor.file);
  }, [editor, handleOpen]);

  const handleOverwrite = useCallback(async () => {
    if (!editor?.conflict) return;
    await handleSave(editor.conflict);
  }, [editor, handleSave]);

  const handleSavePress = useCallback(() => {
    if (!editor) return;
    void handleSave(editor.version);
  }, [editor, handleSave]);

  if (!files.connected || !files.supported) {
    return (
      <SettingsSection
        title={t("settings.host.instructionFiles.sectionTitle")}
        testID="host-instruction-files-section"
      >
        <View style={settingsStyles.card} testID="host-instruction-files-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.mutedText}>
              {files.connected
                ? t("settings.host.instructionFiles.unsupported")
                : t("settings.host.instructionFiles.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.instructionFiles.sectionTitle")}
        testID="host-instruction-files-section"
      >
        <View style={settingsStyles.card} testID="host-instruction-files-card">
          <Text style={styles.sectionHint}>{t("settings.host.instructionFiles.hint")}</Text>
          {files.error ? (
            <Alert
              variant="error"
              title={t("settings.host.instructionFiles.loadFailed")}
              description={files.error.message}
            />
          ) : null}
          <InstructionFilesList
            files={files.files}
            isLoading={files.isLoading}
            error={files.error}
            onOpen={handleOpen}
          />
        </View>
      </SettingsSection>

      {editor ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="host-instruction-files-sheet"
          desktopMaxWidth={560}
        >
          {editor.loadError ? (
            <Alert
              variant="error"
              title={t("settings.host.instructionFiles.loadFailed")}
              description={editor.loadError}
              testID="host-instruction-files-load-error"
            />
          ) : null}
          {editor.conflict ? (
            <Alert
              variant="warning"
              title={t("settings.host.instructionFiles.conflictTitle")}
              description={t("settings.host.instructionFiles.conflictDescription")}
              testID="host-instruction-files-conflict"
            >
              <Button
                variant="outline"
                size="sm"
                onPress={handleReload}
                disabled={editor.saving}
                testID="host-instruction-files-reload"
              >
                {t("settings.host.instructionFiles.reload")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={handleOverwrite}
                disabled={editor.saving}
                testID="host-instruction-files-overwrite"
              >
                {t("settings.host.instructionFiles.overwrite")}
              </Button>
            </Alert>
          ) : null}
          {editor.saveError ? (
            <Alert
              variant="error"
              title={t("settings.host.instructionFiles.saveFailed")}
              description={editor.saveError}
              testID="host-instruction-files-save-error"
            />
          ) : null}
          <SettingsTextAreaCard
            testID="host-instruction-files-input"
            accessibilityLabel={t("settings.host.instructionFiles.accessibilityLabel", {
              filename: editor.file.filename,
            })}
            value={editor.draft}
            onChangeText={handleDraftChange}
            placeholder={t("settings.host.instructionFiles.placeholder")}
          />
          <Text style={styles.sheetHint}>
            {t("settings.host.instructionFiles.appliesAfterSave")}
          </Text>
          <View style={styles.actions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleReset}
              disabled={!hasChanges || editor.saving}
              testID="host-instruction-files-reset"
            >
              {t("settings.host.instructionFiles.reset")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSavePress}
              disabled={!hasChanges || editor.saving}
              testID="host-instruction-files-save"
            >
              {editor.saving
                ? t("settings.host.instructionFiles.saving")
                : t("settings.host.instructionFiles.save")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

function InstructionFilesList({
  files,
  isLoading,
  error,
  onOpen,
}: {
  files: InstructionFileListItem[];
  isLoading: boolean;
  error: Error | null;
  onOpen: (file: InstructionFileListItem) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  if (error) return null;
  if (isLoading && files.length === 0) {
    return (
      <View style={styles.emptyCard} testID="host-instruction-files-loading">
        <Text style={styles.mutedText}>{t("common.loading")}</Text>
      </View>
    );
  }
  if (files.length === 0) {
    return (
      <View style={styles.emptyCard}>
        <Text style={styles.mutedText}>{t("settings.host.instructionFiles.empty")}</Text>
      </View>
    );
  }
  return (
    <>
      {files.map((file, index) => (
        <InstructionFileRow key={file.id} file={file} isFirst={index === 0} onOpen={onOpen} />
      ))}
    </>
  );
}

function InstructionFileRow({
  file,
  isFirst,
  onOpen,
}: {
  file: InstructionFileListItem;
  isFirst: boolean;
  onOpen: (file: InstructionFileListItem) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const providers = file.providers.map((provider) => provider.label).join(", ");
  const hintParts = [file.displayPath];
  if (providers.length > 0) {
    hintParts.push(t("settings.host.instructionFiles.providers", { providers }));
  }
  if (file.missing) hintParts.push(t("settings.host.instructionFiles.missing"));
  const rowStyle = useMemo(
    () => [settingsStyles.row, isFirst ? null : settingsStyles.rowBorder],
    [isFirst],
  );
  const handlePress = useCallback(() => {
    onOpen(file);
  }, [file, onOpen]);

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={file.filename}
      testID={`host-instruction-files-row-${file.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{file.filename}</Text>
        <Text style={settingsStyles.rowHint}>{hintParts.join(" · ")}</Text>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  sectionHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  sheetHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
}));
