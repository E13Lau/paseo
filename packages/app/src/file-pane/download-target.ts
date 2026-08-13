export function buildFilePaneDownloadTarget(input: {
  preview: { path: string } | null;
  readTarget: { path: string } | null;
  filename: string;
}): { fileName: string; path: string } | null {
  if (!input.preview || !input.readTarget) {
    return null;
  }
  return {
    fileName: input.filename,
    path: input.readTarget.path,
  };
}
