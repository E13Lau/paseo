import { describe, expect, it } from "vitest";
import { resolveContextDisplayPercentage } from "./context-window-meter.utils";

describe("resolveContextDisplayPercentage", () => {
  it("returns 0 when the provider does not report context window occupancy", () => {
    expect(resolveContextDisplayPercentage(null, null)).toBe(0);
    expect(resolveContextDisplayPercentage(128_000, null)).toBe(0);
    expect(resolveContextDisplayPercentage(null, 0)).toBe(0);
  });

  it("returns 0 when reported values cannot produce a percentage", () => {
    expect(resolveContextDisplayPercentage(0, 10)).toBe(0);
    expect(resolveContextDisplayPercentage(-1, 10)).toBe(0);
    expect(resolveContextDisplayPercentage(128_000, Number.NaN)).toBe(0);
  });

  it("returns the occupancy percentage when both values are valid", () => {
    expect(resolveContextDisplayPercentage(200, 50)).toBe(25);
  });
});
