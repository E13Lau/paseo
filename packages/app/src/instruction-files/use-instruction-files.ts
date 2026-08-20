import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  InstructionFileListItem,
  InstructionFileWriteResult,
  ProviderInstructionFileGetResponse,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type InstructionFileGetPayload = ProviderInstructionFileGetResponse["payload"];

export function useInstructionFiles(serverId: string) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "providerInstructionFiles");
  const queryKey = useMemo(() => ["host", serverId, "instruction-files"] as const, [serverId]);
  const query = useFetchQuery<InstructionFileListItem[], Error>({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error(t("settings.host.instructionFiles.unavailable"));
      return client.listInstructionFiles();
    },
    enabled: supported && client !== null,
    retry: false,
    dataShape: "list",
    staleTimeMs: 0,
  });
  const refetch = query.refetch;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const getFile = useCallback(
    async (id: string): Promise<InstructionFileGetPayload> => {
      if (!client) throw new Error(t("settings.host.instructionFiles.unavailable"));
      return client.getInstructionFile(id);
    },
    [client, t],
  );
  const writeFile = useCallback(
    async (input: {
      id: string;
      text: string;
      expectedModifiedAt?: string;
      expectedRevision?: string;
    }): Promise<InstructionFileWriteResult> => {
      if (!client) throw new Error(t("settings.host.instructionFiles.unavailable"));
      return client.writeInstructionFile(input);
    },
    [client, t],
  );
  return {
    connected,
    supported,
    files: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refresh,
    getFile,
    writeFile,
  };
}
