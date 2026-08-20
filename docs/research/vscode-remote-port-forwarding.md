# VS Code remote port forwarding research

Researched on 2026-08-13 against VS Code documentation and `microsoft/vscode` commit
[`65a921a`](https://github.com/microsoft/vscode/tree/65a921abc48e3911ccc7635cb33a9343b0bdfcdc).

## Scope

VS Code currently uses **port forwarding** for two different products:

- In a remote workspace, it exposes a service reachable from the remote environment at a local
  client address. This is the relevant model for Paseo. The Remote SSH guide describes the result as
  `localhost:<local-port>` and allows the local and remote ports to differ.
  [Remote SSH: Forwarding a port](https://code.visualstudio.com/docs/remote/ssh#_forwarding-a-port-creating-ssh-tunnel)
- Outside a remote workspace, the built-in Ports view publishes a locally running service through
  Microsoft Dev Tunnels. It returns an internet URL, uses account authentication by default, and
  does not create the client-to-Host loopback mapping Paseo needs.
  [VS Code: Port Forwarding](https://code.visualstudio.com/docs/debugtest/port-forwarding)

The integrated browser has a third behavior: it can proxy browser traffic over the remote
connection without opening a local port. This is closer to Paseo's proposed Host network browser
mode than to a port forward.
[VS Code: Integrated browser](https://code.visualstudio.com/docs/debugtest/integrated-browser#_use-the-integrated-browser-with-remote-workspaces)

## Product model

A forwarded port is identified by the remote endpoint and records:

- remote host and port;
- local address and optional local port;
- a user-visible label;
- source: user, automatic detection, or extension;
- detected process and PID when available;
- presentation protocol (`http` or `https`);
- provider-specific privacy and closeability.

The model keys forwards by remote `host:port`, treats loopback spellings as equivalent, and also
treats loopback and all-interface listeners as equivalent for duplicate detection. Manual input
accepts either a port or `host:port`, defaulting the host to `localhost`.
[Tunnel model and address parsing](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/services/remote/common/tunnelModel.ts#L30-L137)

The Ports view is the durable control surface. It supports adding and stopping a forward, copying or
opening its local address, naming it, changing the local port, and changing `http`/`https` metadata.
It also exposes a count in the status bar.
[Ports view actions](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/contrib/remote/browser/tunnelView.ts#L1180-L1582)

## Local binding and port conflicts

The desired local port defaults to the remote port. The desktop implementation binds a Node TCP
server to loopback by default. A setting can instead bind all interfaces, but loopback is the safe
default. Privileged local ports can require elevation.
[Tunnel service configuration](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/platform/tunnel/common/tunnel.ts#L119-L163)
[Node tunnel listener](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/platform/tunnel/node/tunnelService.ts#L30-L115)

If the preferred local port is unavailable, VS Code selects another free port and reports the actual
address. `requireLocalPort` changes this from a quiet remap into a modal warning; it does not make the
forward succeed on an occupied port. Changing the local port closes and recreates the forward, so
existing connections are interrupted.
[Port mismatch and forward creation](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/services/remote/common/tunnelModel.ts#L677-L755)
[Change local port action](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/contrib/remote/browser/tunnelView.ts#L1480-L1532)

## Transport behavior

The desktop path is protocol-agnostic TCP forwarding. Each accepted local socket opens a remote
agent tunnel to the requested remote host and port, then mirrors bytes in both directions. Closing
the forward closes its listener and active sockets. The `http`/`https` property only controls URI
construction and browser actions; it does not change the forwarded bytes.
[Node remote tunnel](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/platform/tunnel/node/tunnelService.ts#L30-L178)
[HTTP/HTTPS URI construction](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/services/remote/common/tunnelModel.ts#L550-L558)

The tunnel service is an abstraction rather than a promise that every client owns an OS listener.
A provider may return a URL as `localAddress`; this is how browser and hosted environments can use
the same Ports view without binding browser-side localhost.
[Tunnel interfaces](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/platform/tunnel/common/tunnel.ts#L20-L141)

## Discovery and lifecycle

VS Code separates explicit forwarding from discovery:

- `process` watches listening processes;
- `output` recognizes URLs in terminal and debug output;
- `hybrid` discovers from output and watches processes to know when a port stops listening.

Automatic forwarding is enabled by default. Port attributes can label a port, ignore it, forward it
silently, notify, or open a browser/preview. Attributes may target a port, range, `host:port`, or a
process-command regular expression.
[Remote port settings](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/contrib/remote/common/remote.contribution.ts#L222-L364)

Manually and automatically forwarded ports have different shutdown semantics. When an automatically
forwarded process disappears, VS Code closes that forward and caches its chosen local port, label,
and privacy for reuse during the session. User-created forwards remain until the user closes them or
the remote session ends.
[Automatic close behavior](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/services/remote/common/tunnelModel.ts#L795-L845)

Restore is enabled by default. VS Code stores restorable forwards per remote authority and workspace
in profile storage, preserves the chosen local port and label, and expires stored entries after two
weeks.
[Restore storage](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/services/remote/common/tunnelModel.ts#L20-L25)
[Restore behavior](https://github.com/microsoft/vscode/blob/65a921abc48e3911ccc7635cb33a9343b0bdfcdc/src/vs/workbench/services/remote/common/tunnelModel.ts#L560-L676)

## What Paseo should borrow

These are research conclusions, not accepted Paseo decisions:

- Model the feature as a **port forward**, not as an HTTP proxy. TCP makes web servers, databases,
  language servers, and other development services use the same path.
- Keep remote target, requested local port, and actual local address separate. Default to the same
  port, but represent conflict remapping explicitly.
- Bind loopback by default. Do not copy VS Code's all-interface option into the first release; it
  turns a private client capability into LAN exposure.
- Give manual forwards an explicit lifecycle and source. Add automatic discovery later instead of
  making process observation a prerequisite for the transport.
- Treat `http`/`https` as optional presentation metadata for Open and Copy actions. Do not make the
  stream implementation depend on it.
- Reuse the authenticated Host connection for data transport. A Paseo implementation can preserve
  direct, relay, and E2EE relay boundaries while avoiding a second Host listener.
- Keep the browser Host-network setting and port forwards as separate product concepts, but share a
  multiplexed Host tunnel stream layer underneath them.

## Paseo-specific questions left open

VS Code does not answer these because its ownership model is one remote authority plus one active
workspace:

- Is a Paseo forward owned by a Host, a workspace, or a desktop/CLI process?
- Should a manual forward survive app restart, Host reconnect, workspace closure, or all three?
- When the requested local port is occupied, should Paseo choose another port like VS Code or fail
  because callers may depend on an exact address?
- Does the first release allow only Host loopback targets or arbitrary addresses reachable from the
  Host?
- Is the first client Electron only, or should a headless `paseo forward` command own listeners too?
- Should declared workspace `service` scripts offer a one-click forward while remaining distinct
  from the HTTP Service Proxy?
