import { describe, expect, it } from "vitest";
import { resolvePortForwardCapability } from "./capability";

describe("port forward capability", () => {
  it("treats a previously confirmed Host as capable while disconnected", () => {
    expect(
      resolvePortForwardCapability({
        serverId: "host-a",
        isConnected: true,
        feature: true,
        hasRestoredForward: false,
      }),
    ).toBe("supported");
    expect(
      resolvePortForwardCapability({
        serverId: "host-a",
        isConnected: false,
        feature: undefined,
        hasRestoredForward: false,
      }),
    ).toBe("supported");
  });

  it("does not allow create when capability is unknown or unsupported", () => {
    expect(
      resolvePortForwardCapability({
        serverId: "host-unknown",
        isConnected: false,
        feature: undefined,
        hasRestoredForward: false,
      }),
    ).toBe("unknown");
    expect(
      resolvePortForwardCapability({
        serverId: "host-old",
        isConnected: true,
        feature: undefined,
        hasRestoredForward: false,
      }),
    ).toBe("unsupported");
  });
});
