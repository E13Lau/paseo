export function parsePortForwardOpenUrl(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.url !== "string") {
    throw new Error("Open requires a localhost URL");
  }
  const url = new URL(raw.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Open requires a localhost URL");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Open is limited to the Port Forward localhost address");
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
