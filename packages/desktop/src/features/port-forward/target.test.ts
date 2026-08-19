import { describe, expect, it } from "vitest";
import { parsePortForwardTarget } from "./target.js";

describe("parsePortForwardTarget", () => {
  it("parses a port alone as Host localhost", () => {
    expect(parsePortForwardTarget("8080")).toEqual({
      host: "localhost",
      port: 8080,
      identity: "localhost:8080",
      display: "localhost:8080",
    });
  });

  it("normalizes loopback and all-interface spellings", () => {
    expect(parsePortForwardTarget("127.0.0.1:3000").identity).toBe("localhost:3000");
    expect(parsePortForwardTarget("[::1]:3000").identity).toBe("localhost:3000");
    expect(parsePortForwardTarget("0.0.0.0:3000").identity).toBe("localhost:3000");
    expect(parsePortForwardTarget("[::]:3000").identity).toBe("localhost:3000");
    expect(parsePortForwardTarget("localhost:3000").identity).toBe("localhost:3000");
  });

  it("keeps non-loopback IPv4, hostnames, and IPv6 distinct", () => {
    expect(parsePortForwardTarget("10.0.0.8:5432")).toEqual({
      host: "10.0.0.8",
      port: 5432,
      identity: "10.0.0.8:5432",
      display: "10.0.0.8:5432",
    });
    expect(parsePortForwardTarget("db.internal:5432").display).toBe("db.internal:5432");
    expect(parsePortForwardTarget("[2001:db8::1]:443")).toEqual({
      host: "2001:db8::1",
      port: 443,
      identity: "2001:db8::1:443",
      display: "[2001:db8::1]:443",
    });
  });

  it("rejects ports outside 1-65535", () => {
    expect(() => parsePortForwardTarget("0")).toThrow(/1 and 65535/);
    expect(() => parsePortForwardTarget("65536")).toThrow(/1 and 65535/);
    expect(() => parsePortForwardTarget("host:70000")).toThrow(/1 and 65535/);
  });
});
