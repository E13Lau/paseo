import { describe, expect, it } from "vitest";
import { isKnownRemoteHost } from "./use-is-local-daemon";

describe("isKnownRemoteHost", () => {
  it("hides Ports until the local daemon id is resolved", () => {
    expect(isKnownRemoteHost("remote", { status: "loading" })).toBe(false);
    expect(isKnownRemoteHost("remote", { status: "error" })).toBe(false);
    expect(isKnownRemoteHost("remote", { status: "resolved", serverId: null })).toBe(false);
  });

  it("hides Ports for the built-in local Host", () => {
    expect(isKnownRemoteHost("local", { status: "resolved", serverId: "local" })).toBe(false);
  });

  it("shows Ports only when the resolved local id does not match", () => {
    expect(isKnownRemoteHost("remote", { status: "resolved", serverId: "local" })).toBe(true);
  });
});
