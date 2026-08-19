# Port Forward

Status: Proposed

Port Forward makes a service reachable from a remote Host available through a loopback TCP address on the Electron client. It follows the Remote SSH Ports model: the client owns the listener and the Host opens each target connection.

## Scope

Electron on macOS, Windows, and Linux supports a client-to-Host TCP forward:

```text
localhost:8080 on the client → localhost:8080 from the Host
```

The Host target may be any address reachable from the Host. A port alone means Host `localhost`; hostname and IPv4 targets use `host:port`, and IPv6 targets use `[address]:port`.

Every forward listens on both `127.0.0.1` and `::1` using the same port. The primary address is `localhost:<port>` and both IP addresses work. The client never listens on LAN interfaces and never requests elevation for a privileged local port.

Port Forward carries TCP bytes without interpreting them. `Open as` is optional presentation metadata: `None`, `HTTP`, or `HTTPS`. It controls whether the UI offers a browser action and does not affect the stream.

The first release excludes mobile, browser web, CLI listeners, reverse forwarding, UDP, Unix sockets, named pipes, public URLs, sharing, listener authentication, automatic port discovery, and TCP stream recovery after a transport disconnect.

## Ownership and persistence

A forward belongs to one Host and one Electron client device. Workspaces, windows, and agent sessions do not own it. A normalized Host target has at most one forward per client device.

Electron main owns the definitions, listeners, live streams, and a main-process `userData` store keyed by `serverId`. The renderer reads and mutates that state through IPC. The renderer synchronizes current Host connection candidates to main memory; main does not persist a second copy of Host credentials or connection configuration.

Manual forwards persist until **Stop Forwarding** or Host removal. Electron restores their listeners before the Host reconnects and shows **Waiting for Host** while it cannot route traffic. On macOS, closing all windows does not stop them; only quitting Electron does. Removing a Host deletes its definitions. A Host `serverId` rekey migrates them.

The requested local port defaults to the target port. A forward without **Require local port** may choose another dual-stack port when the requested port is occupied. The chosen port becomes the saved preferred port so later launches remain stable. With **Require local port**, creation fails instead.

## User experience

Show a **Ports** group on a remote Host's settings page in Electron. Hide it for the built-in local Host and every non-Electron client.

Creating a forward accepts Host address, label, optional local port, **Require local port**, and **Open as**. The form accepts a Host that was previously confirmed capable while disconnected, but not one whose capability is unknown or unsupported.

The main states are:

- **Starting** — binding the dual-stack listener.
- **Waiting for Host** — listener bound; tunnel unavailable.
- **Update Host required** — listener bound; daemon lacks the capability.
- **Ready** — listener and tunnel session are available.
- **Port unavailable** — no permitted dual-stack local port can bind.
- **Error** — main-process failure; the user can retry.

Ready does not attest that the Host target is currently listening. DNS failure, refusal, and target timeout are recorded as a recent connection error, then the individual local socket resets. A target connect attempt times out after 10 seconds; the next connection resolves the target hostname again and retries.

Changing label or Open as leaves the listener and streams intact. Changing target, local port, or strictness first binds the replacement listener; the old forward remains live if that fails. A successful switch closes old streams. Stop Forwarding closes its listener and streams and removes the definition. The first release has no Pause state.

Running workspace Services provide a **Forward Port** shortcut. It pre-fills the Host loopback target, a service label, and HTTP presentation metadata. The resulting forward remains independent when that Service stops or is removed.

## Host tunnel

Port Forward and Browser Host network share a dedicated authenticated Host tunnel session that Electron main owns per Host. The session exists while either capability is active and uses the normal direct TCP, socket/pipe, relay, and E2EE relay connection mechanisms. It can select and fail over between Host connection candidates independently from renderer control sessions.

One accepted local socket creates one Host TCP stream. Streams preserve byte order and TCP half-close. When the tunnel session disconnects, every active stream closes; a later local connection uses the reconnected session. Streams never move across physical sessions.

The binary codec has Open, OpenResult, Data, HalfClose, Reset, and WindowUpdate frames with a main-process stream ID. Host target data and stream bytes remain binary and are never base64 encoded or carried in JSON. Per-stream credits, session-wide queue limits, bounded frame sizes, and fair data scheduling prevent one stream from starving another. Control frames take priority. Load testing chooses the concrete defaults; a limit rejects new streams and pauses only the affected local reader.

## Security and compatibility

Creating a forward authorizes the authenticated Paseo operator to reach its Host target. Paseo does not add a target denylist or a daemon-wide forwarding switch. Loopback reachability is the client-side access boundary, so the UI explains that local processes can use the listener.

Normal logs record forward and stream IDs, byte counts, duration, and error categories. Network-debug mode may include targets and warns that logs can contain private-network or browsing data.

Gate the capability once on `server_info.features.portForward`. New Electron clients advertise `CLIENT_CAPS.hostTunnelStreams`; the daemon accepts or sends Host tunnel binary frames only when that capability is present. An older Host leaves existing listeners bound with **Update Host required**. There is no fallback to Service Proxy, client network, or a public Host listener.

See [browser-network.md](browser-network.md) for the shared Browser Host network contract and [ADR-0002](adr/0002-share-the-host-tunnel-stream-substrate.md) for the tunnel ownership decision.

## Release evidence

Do not mark Port Forward complete without evidence for every row. Automated coverage lives next to the seam; desktop transport rows still need a human/CI Electron run.

| Area              | Required evidence                                                                                      | Automated now                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Stream bytes      | TCP echo, HTTP, HTTPS, WebSocket, half-close                                                           | Codec + in-process daemon echo/half-close; HTTP/HTTPS/WebSocket still need a desktop run |
| Host targets      | localhost, private IPv4, IPv6, Host DNS/hosts-file, custom ports                                       | Target parser + daemon connect to 127.0.0.1; DNS/IPv6/hosts-file need a Host run         |
| Transports        | Direct TCP, socket/pipe, relay, E2EE relay, candidate switching                                        | Direct TCP via in-process daemon; other transports need a desktop run                    |
| Lifecycle         | Create, strict/auto port, transactional edits, Stop, restore, no-window, Host delete, server-id rekey  | PortForwardManager + store tests                                                         |
| Sharing           | Multiple windows, two Hosts, Port Forward with Browser Host network, flow-control fairness, exhaustion | Two-Host + flow-control unit tests; Browser sharing and multi-window need a desktop run  |
| Fail closed       | DNS failure, target timeout, disconnect, old Host, no fallback                                         | Timeout/refuse/old-client daemon tests                                                   |
| Desktop platforms | Real Electron on macOS, Windows, and Linux                                                             | Dual-stack binder unit tests on the current OS only                                      |
