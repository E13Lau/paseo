# Share the Host tunnel stream substrate

Status: accepted

Port Forward and Browser Host network remain separate product capabilities but share one multiplexed Host tunnel stream substrate on a dedicated, authenticated background session per Host. The Electron main process owns that session so listeners and browser routing do not depend on a renderer window. It uses the existing direct, socket/pipe, relay, and E2EE connection mechanisms, centralizes stream framing and resource controls, and avoids a listening Host proxy.
