import { describe, expect, it } from "vitest";
import { openPortForwardForm } from "./form-model";

describe("port forward form model", () => {
  it("accepts a previously confirmed capable Host and a port-only target", () => {
    const model = openPortForwardForm({ mode: "create", capability: "supported" });
    model.setTarget("8080");
    model.setLabel("web");
    model.setOpenAs("http");
    expect(model.getState()).toMatchObject({
      target: "8080",
      canSubmit: true,
      targetError: null,
    });
  });

  it("rejects submit when capability is unknown or unsupported", () => {
    const unknown = openPortForwardForm({ mode: "create", capability: "unknown" });
    unknown.setTarget("8080");
    expect(unknown.getState().canSubmit).toBe(false);

    const unsupported = openPortForwardForm({ mode: "create", capability: "unsupported" });
    unsupported.setTarget("8080");
    expect(unsupported.getState().canSubmit).toBe(false);
  });

  it("seeds edit from the existing record", () => {
    const model = openPortForwardForm({
      mode: "edit",
      capability: "supported",
      record: {
        targetDisplay: "localhost:3000",
        label: "api",
        preferredLocalPort: 3001,
        requireLocalPort: true,
        openAs: "https",
      },
    });
    expect(model.getState()).toMatchObject({
      target: "localhost:3000",
      label: "api",
      localPort: "3001",
      requireLocalPort: true,
      openAs: "https",
      canSubmit: true,
    });
  });
});
