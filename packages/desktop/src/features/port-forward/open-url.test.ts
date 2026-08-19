import { describe, expect, it } from "vitest";
import { parsePortForwardOpenUrl } from "./open-url.js";

describe("parsePortForwardOpenUrl", () => {
  it("accepts IPv6 loopback", () => {
    expect(parsePortForwardOpenUrl({ url: "http://[::1]:8080/" })).toBe("http://[::1]:8080/");
  });

  it("accepts localhost and 127.0.0.1", () => {
    expect(parsePortForwardOpenUrl({ url: "https://localhost:3000/" })).toBe(
      "https://localhost:3000/",
    );
    expect(parsePortForwardOpenUrl({ url: "http://127.0.0.1:80/" })).toBe("http://127.0.0.1/");
  });

  it("rejects non-loopback hosts", () => {
    expect(() => parsePortForwardOpenUrl({ url: "http://example.com/" })).toThrow(/localhost/);
  });
});
