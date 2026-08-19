import { EventEmitter } from "node:events";
import type {
  HostConnectionCandidate,
  HostTunnelConnector,
  HostTunnelHandle,
  HostTunnelStream,
} from "./types.js";

export class ControllableHostTunnelStream implements HostTunnelStream {
  readonly streamId: number;
  readonly target: { host: string; port: number };
  written: Uint8Array[] = [];
  halfClosed = false;
  resetCategory: string | null = null;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly halfCloseListeners = new Set<() => void>();
  private readonly resetListeners = new Set<(category: string) => void>();
  private readonly windowListeners = new Set<() => void>();
  private writePaused = false;

  constructor(streamId: number, target: { host: string; port: number }) {
    this.streamId = streamId;
    this.target = target;
  }

  write(data: Uint8Array): boolean {
    this.written.push(data);
    return !this.writePaused;
  }

  halfClose(): void {
    this.halfClosed = true;
  }

  reset(): void {
    this.resetCategory = "reset";
  }

  acknowledgeInbound(): void {}

  emitReady(): void {
    for (const listener of this.windowListeners) listener();
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataListeners.add(cb);
  }

  onHalfClose(cb: () => void): void {
    this.halfCloseListeners.add(cb);
  }

  onReset(cb: (category: string) => void): void {
    this.resetListeners.add(cb);
  }

  onWindowAvailable(cb: () => void): void {
    this.windowListeners.add(cb);
  }

  emitData(data: Uint8Array): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitHalfClose(): void {
    for (const listener of this.halfCloseListeners) listener();
  }

  emitReset(category: string): void {
    for (const listener of this.resetListeners) listener(category);
  }

  setWritePaused(paused: boolean): void {
    this.writePaused = paused;
    if (!paused) {
      for (const listener of this.windowListeners) listener();
    }
  }
}

export class ControllableHostTunnelHandle implements HostTunnelHandle {
  state: HostTunnelHandle["state"] = "connecting";
  streams: ControllableHostTunnelStream[] = [];
  candidates: HostConnectionCandidate[] = [];
  closed = false;
  private nextStreamId = 1;
  private readonly emitter = new EventEmitter();

  constructor(private readonly onStateChange: (state: HostTunnelHandle["state"]) => void) {}

  setCandidates(candidates: HostConnectionCandidate[]): void {
    this.candidates = candidates;
  }

  setState(state: HostTunnelHandle["state"]): void {
    this.state = state;
    this.onStateChange(state);
  }

  openStream(target: { host: string; port: number }): HostTunnelStream {
    const stream = new ControllableHostTunnelStream(this.nextStreamId, target);
    this.nextStreamId += 1;
    this.streams.push(stream);
    this.emitter.emit("open", stream);
    return stream;
  }

  close(): void {
    this.closed = true;
    this.setState("disconnected");
    for (const stream of this.streams) {
      stream.emitReset("reset");
    }
  }

  onOpen(cb: (stream: ControllableHostTunnelStream) => void): void {
    this.emitter.on("open", cb);
  }
}

export class ControllableHostTunnelConnector implements HostTunnelConnector {
  handles: ControllableHostTunnelHandle[] = [];

  connect(input: {
    serverId: string;
    candidates: HostConnectionCandidate[];
    onStateChange: (state: HostTunnelHandle["state"]) => void;
  }): HostTunnelHandle {
    const handle = new ControllableHostTunnelHandle(input.onStateChange);
    handle.setCandidates(input.candidates);
    this.handles.push(handle);
    return handle;
  }

  latest(): ControllableHostTunnelHandle {
    const handle = this.handles.at(-1);
    if (!handle) {
      throw new Error("expected a Host tunnel handle");
    }
    return handle;
  }
}
