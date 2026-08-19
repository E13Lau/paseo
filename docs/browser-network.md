# Browser network location

Status: Proposed

The Electron in-app browser can use the client device's network or the network of the Host that owns its workspace. The choice is per Host and per client device. Existing and new Hosts use Client network until the user opts into Host network.

## Product contract

| Boundary                                                         | Client network                 | Host network                                      |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| DNS, TCP, UDP, and public egress IP                              | Client device                  | Workspace Host                                    |
| Chromium process and browser fingerprint                         | Client device                  | Client device                                     |
| TLS trust, client certificates, WebAuthn, and device permissions | Client device                  | Client device                                     |
| Downloads, clipboard, camera, and microphone                     | Client device                  | Client device                                     |
| Browser data                                                     | Existing shared client profile | One persistent profile per Host and client device |

Host network changes routing only. A private CA, client certificate, PAC file, or browser-integrated login installed on the Host does not become available to Electron. The Host's OS resolver, routing table, VPN, and hosts file apply; Host system proxies and `HTTP_PROXY`/`ALL_PROXY` do not.

The mode covers HTTP, HTTPS, WebSocket, downloads, and WebRTC UDP. HTTP/3 or QUIC may use the tunnel when Chromium can proxy it; otherwise Chromium must fall back to HTTP/2 or TCP through the tunnel. The feature is not a general VPN and does not expose raw sockets to pages or extensions.

## Availability and setting

Show a **Browser** group on a Host's Overview page in Electron. Hide it in web, iOS, Android, and for Paseo's built-in local Host.

The group contains:

- **Use Host network** — off means Client network; on means Host network.
- **Route this Host's browser tabs through the Host** — the base explanation.
- A warning that browser tabs and enabled Browser tools can reach network resources available to the Host.

Persist the preference on the client-owned Host profile. The stored field is optional and normalizes to Client network so existing profiles keep their behavior. The preference never follows the Host to another client device.

Gate the switch once on the optional `server_info.features.browserNetworkTunnel` capability. An old daemon leaves the switch disabled and tells the user to update the Host. A disconnected Host leaves it disabled until the client can verify the capability. There is no compatibility fallback.

Enabling Host network is transactional:

1. Start the authenticated loopback proxy endpoint.
2. Probe the daemon capability and establish the tunnel.
3. Ask for confirmation when the Host owns an open browser tab.
4. Persist the preference.
5. Recreate that Host's browser guests in the Host profile and reload their saved URLs.

Failure before step 4 leaves the preference, tabs, and active network unchanged. Switching back to Client network uses the same confirmation and recreation boundary, without requiring a daemon probe.

The confirmation says that changing network location reloads this Host's browser tabs and loses unsubmitted page content and active downloads. It also interrupts WebSocket, WebRTC, and other live page connections. Cancel leaves the setting and tabs unchanged.

## Browser profiles

Keep `persist:paseo-browser` as the shared Client network profile. A Host network profile uses a stable partition derived from `serverId` without placing the raw identifier in the partition name. Workspaces and desktop windows for the same Host share that Host profile. Different Hosts never share Host network cookies, cache, authentication, or site storage.

Changing network location does not copy browser data. Switching back to Client network restores the existing shared Client profile; switching to Host network restores that Host's prior profile.

Settings > General > Clear browser data clears the Client profile and every Host profile, then reloads live guests without deleting tabs or saved URLs. Update its description to say that it clears every network location. Removing a Host deletes its Host profile and says so in the removal confirmation. Re-adding that `serverId` starts with empty Host browser data.

## Tunnel boundary

Electron runs a temporary authenticated SOCKS5 endpoint bound only to loopback. Generate new proxy credentials on every desktop launch and answer Chromium's proxy authentication challenge inside the main process. Another local process cannot use the endpoint without those credentials. The Host never opens a proxy listener.

The Electron main process maintains one dedicated, authenticated background Host tunnel session for every Host with an active network capability. Port Forward and Browser Host network share that physical session, which stays alive without a renderer window. Direct TCP, direct socket/pipe, relay, and E2EE relay use their existing connection mechanisms and application boundary; tunnel content never leaves relay encryption.

Use dotted `browser.network.*.request` / `.response` messages for tunnel setup, teardown, and correlated errors. Add a dedicated binary frame codec for per-stream open, data, close, and UDP datagrams. Preserve UDP datagram boundaries. Keep target addresses and payload bytes out of JSON, and never base64 tunnel traffic.

Each tunnel belongs to one authenticated daemon session. Multiple clients may tunnel through one Host without sharing state. Closing a session destroys only its TCP streams, UDP associations, DNS work, and queues.

UDP uses the existing reliable, ordered Paseo transport in the first release. This prevents client-network leakage but can turn packet loss into latency, especially over relay. Host network is suitable for development services and private sites; it does not promise video-call performance.

## Failure and resource behavior

Host network never falls back to Client network. A disconnect, capability loss, proxy failure, DNS error, resource limit, or tunnel error fails closed.

On startup, a restored Host-network tab waits for the Host connection, capability check, and tunnel before creating its browser guest or loading its URL. Show **Connecting to Host network** while waiting. A failure leaves the tab in a retryable error state without making a client-network request.

An already loaded page remains visible after disconnect. Put **Host network unavailable** in the browser toolbar while new traffic fails. After reconnect, change the status to **Host network restored** and let the user reload; do not refresh automatically. Browser automation returns a network-unavailable error instead of opening or using a client-network tab.

Show a persistent **Host network** indicator beside the address bar whenever the mode is active. Reuse it for connecting, unavailable, and restored states. Clicking it opens that Host's Overview page. Client network adds no indicator.

Limit TCP streams, UDP associations, queued bytes, and idle lifetime per authenticated client. Reject new work at a limit and keep established streams. Keep the tunnel's queue below the physical WebSocket high-water mark so browser traffic cannot silently consume the control connection's entire send budget. Choose concrete defaults from load tests.

Default logs contain tunnel lifecycle, byte counts, duration, and error categories without target domains or IP addresses. An explicit network-debug mode may record targets, and its UI or command must warn that the output contains browsing history.

## Security boundary

The setting is the user's authorization for pages to reach the Host network. Browser tools remain a separate opt-in for agent control of those pages. Do not add a daemon-wide Host-network switch: an authenticated Paseo client is already a trusted operator that can run commands and reach the same resources through an agent or terminal.

Chromium still enforces its certificate, same-origin, CORS, permission, and safe-browsing policies. These controls do not prevent navigations or all cross-site requests to private services. Treat Host network as private-network authority, not as an SSRF filter.

TLS stays end to end between client-side Chromium and the destination. The daemon resolves destinations and forwards bytes, so it can observe target addresses, timing, and sizes but does not terminate destination TLS.

Set every Host-network guest's WebRTC IP handling policy to disallow non-proxied UDP. WebRTC may use UDP only through the configured proxy and otherwise falls back to proxied TCP. Verify client IP non-disclosure before release.

## Release evidence

Do not mark the feature complete until the pull request carries evidence for every row.

| Area              | Required evidence                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Transports        | Direct TCP, direct socket/pipe, relay, and E2EE relay                                                                         |
| Web traffic       | HTTP, HTTPS, WebSocket, downloads, redirects, and certificate failures                                                        |
| Host reachability | Host DNS search, hosts file, `localhost`, private IPv4, IPv6, and custom ports                                                |
| UDP               | WebRTC uses the Host public IP and never exposes or sends through the client network                                          |
| Strict routing    | DNS failure, tunnel failure, disconnect, and resource exhaustion never fall back                                              |
| Lifecycle         | Transactional enable, cancel, disable, startup restore, reconnect, retry, and active-transfer interruption                    |
| Isolation         | Two Hosts use different network locations concurrently; two clients use one Host without sharing tunnels or Host browser data |
| Data deletion     | Global clearing covers every partition; Host removal deletes only that Host profile                                           |
| Compatibility     | New app with old daemon, old app with new daemon, and the single capability gate                                              |
| Desktop platforms | Real Electron evidence on macOS, Windows, and Linux                                                                           |

## Out of scope

- Mobile or browser-web embedded browsing
- The built-in local Host, where Host and client share a network namespace
- Host PAC files, system proxy settings, and proxy environment variables
- Running Chromium on the Host or streaming a remote browser UI
- A general-purpose device VPN or raw socket API
- A new datagram transport for Paseo or the relay
