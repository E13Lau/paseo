import net from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  HostTunnelErrorCode,
  HostTunnelOpcode,
  decodeHostTunnelFrame,
  encodeHostTunnelFrame,
  type HostTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";

const TEST_TIMEOUT_MS = 20_000;

let daemon: TestPaseoDaemon | undefined;
const sockets: WebSocket[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.unref();
          setTimeout(resolve, 200);
        }),
    ),
  );
  await daemon?.close();
  daemon = undefined;
});

test(
  "capable clients can echo TCP bytes through Host tunnel frames",
  async () => {
    const target = await listenEcho();
    daemon = await createTestPaseoDaemon();
    const { socket } = await connectSocket(daemon.port, "tunnel-client", {
      host_tunnel_streams: true,
    });
    sockets.push(socket);

    const opened = waitForFrame(
      socket,
      (frame) => frame.opcode === HostTunnelOpcode.OpenResult && frame.streamId === 1,
    );
    socket.send(
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Open,
        streamId: 1,
        host: "127.0.0.1",
        port: target.port,
      }),
    );
    expect(await opened).toEqual({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: 1,
      ok: true,
      errorCode: HostTunnelErrorCode.Ok,
    });

    const echoed = waitForFrame(
      socket,
      (frame) => frame.opcode === HostTunnelOpcode.Data && frame.streamId === 1,
    );
    socket.send(
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Data,
        streamId: 1,
        payload: new TextEncoder().encode("hello-tunnel"),
      }),
    );
    const data = await echoed;
    expect(data).toEqual({
      opcode: HostTunnelOpcode.Data,
      streamId: 1,
      payload: new TextEncoder().encode("hello-tunnel"),
    });

    const halfClosed = waitForFrame(
      socket,
      (frame) => frame.opcode === HostTunnelOpcode.HalfClose && frame.streamId === 1,
    );
    socket.send(encodeHostTunnelFrame({ opcode: HostTunnelOpcode.HalfClose, streamId: 1 }));
    expect(await halfClosed).toEqual({ opcode: HostTunnelOpcode.HalfClose, streamId: 1 });
  },
  TEST_TIMEOUT_MS,
);

test(
  "old clients do not receive Host tunnel frames and cannot open streams",
  async () => {
    const target = await listenEcho();
    daemon = await createTestPaseoDaemon();
    const { socket } = await connectSocket(daemon.port, "legacy-client");
    sockets.push(socket);

    const inbound: HostTunnelFrame[] = [];
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeHostTunnelFrame(new Uint8Array(data as Buffer));
      if (frame) inbound.push(frame);
    });

    socket.send(
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Open,
        streamId: 1,
        host: "127.0.0.1",
        port: target.port,
      }),
    );
    await delay(150);
    expect(inbound).toEqual([]);
    expect(target.connections).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "target refusal resets only that stream and advertises portForward to new clients",
  async () => {
    daemon = await createTestPaseoDaemon();
    const { socket, serverInfo } = await connectSocket(daemon.port, "tunnel-client", {
      host_tunnel_streams: true,
    });
    sockets.push(socket);
    expect(serverInfo.features?.portForward).toBe(true);

    const refused = waitForFrame(
      socket,
      (frame) => frame.opcode === HostTunnelOpcode.OpenResult && frame.streamId === 9,
    );
    socket.send(
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Open,
        streamId: 9,
        host: "127.0.0.1",
        port: 1,
      }),
    );
    expect(await refused).toEqual({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: 9,
      ok: false,
      errorCode: HostTunnelErrorCode.Refused,
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a refused target leaves the session open for later streams",
  async () => {
    const target = await listenEcho();
    daemon = await createTestPaseoDaemon();
    const { socket } = await connectSocket(daemon.port, "tunnel-retry", {
      host_tunnel_streams: true,
    });
    sockets.push(socket);

    const refused = waitForFrame(
      socket,
      (frame) => frame.opcode === HostTunnelOpcode.OpenResult && frame.streamId === 2,
    );
    socket.send(
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Open,
        streamId: 2,
        host: "127.0.0.1",
        port: 1,
      }),
    );
    expect(await refused).toMatchObject({ ok: false, errorCode: HostTunnelErrorCode.Refused });

    const opened = waitForFrame(
      socket,
      (frame) => frame.opcode === HostTunnelOpcode.OpenResult && frame.streamId === 3,
    );
    socket.send(
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Open,
        streamId: 3,
        host: "127.0.0.1",
        port: target.port,
      }),
    );
    expect(await opened).toMatchObject({ ok: true });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  },
  TEST_TIMEOUT_MS,
);

async function listenEcho(): Promise<{ port: number; connections: number }> {
  const state = { port: 0, connections: 0 };
  const server = net.createServer((connection) => {
    state.connections += 1;
    connection.pipe(connection);
  });
  servers.push(server);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  state.port = address.port;
  return state;
}

function listen(server: net.Server, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function connectSocket(
  port: number,
  clientId: string,
  capabilities?: Record<string, unknown>,
): Promise<{
  socket: WebSocket;
  serverInfo: { features?: { portForward?: boolean } };
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const hello: Record<string, unknown> = {
    type: "hello",
    clientId,
    clientType: "browser",
    protocolVersion: 1,
  };
  if (capabilities) {
    hello.capabilities = capabilities;
  }
  const message = await sendAndWait(
    socket,
    hello,
    (candidate) =>
      candidate.type === "session" &&
      candidate.message.type === "status" &&
      candidate.message.payload.status === "server_info",
  );
  if (message.type !== "session" || message.message.type !== "status") {
    throw new Error("expected server_info");
  }
  return {
    socket,
    serverInfo: message.message.payload as { features?: { portForward?: boolean } },
  };
}

function waitForFrame(
  socket: WebSocket,
  matches: (frame: HostTunnelFrame) => boolean,
): Promise<HostTunnelFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for host tunnel frame"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeHostTunnelFrame(new Uint8Array(data as Buffer));
      if (!frame || !matches(frame)) return;
      cleanup();
      resolve(frame);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = new Promise<WSOutboundMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
  socket.send(JSON.stringify(message));
  return response;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
