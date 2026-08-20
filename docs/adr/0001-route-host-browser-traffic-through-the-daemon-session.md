# Route Host browser traffic through the daemon session

Status: accepted; physical session ownership superseded by ADR-0002

Host network routes the client-side Electron browser through an authenticated, client-scoped Host tunnel session. It fails closed, keeps destination TLS in Chromium, and gives each Host a separate browser-data profile. We chose this over a public Host proxy, client-network fallback, or Host-rendered browser because it preserves Paseo's direct and E2EE relay trust boundaries while supporting Host DNS, localhost, private networks, and UDP without moving the browser UI or identity to the Host. ADR-0002 moves physical session ownership to the Electron main process so network capabilities survive without a renderer window. See [browser-network.md](../browser-network.md) for the product and protocol contract.
