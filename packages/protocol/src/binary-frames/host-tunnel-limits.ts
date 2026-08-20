/**
 * Provisional Host tunnel resource limits.
 * Chosen as explicit named defaults until load testing replaces them.
 * Do not treat these as measured production evidence.
 */
export const HOST_TUNNEL_LIMITS = {
  MAX_STREAMS_PER_SESSION: 64,
  INITIAL_STREAM_WINDOW_BYTES: 64 * 1024,
  MAX_STREAM_WINDOW_BYTES: 256 * 1024,
  MAX_SESSION_QUEUED_BYTES: 1024 * 1024,
  MAX_DATA_FRAME_BYTES: 16 * 1024,
  TARGET_CONNECT_TIMEOUT_MS: 10_000,
} as const;

export type HostTunnelLimits = typeof HOST_TUNNEL_LIMITS;
