import { describe, expect, it } from "vitest";
import { cpuPercentBetween } from "./system-metrics";

describe("Linux server CPU sampling", () => {
  it("computes bounded usage between cumulative CPU samples", () => {
    expect(cpuPercentBetween({ idle: 50, total: 100 }, { idle: 75, total: 200 })).toBe(75);
    expect(cpuPercentBetween({ idle: 50, total: 100 }, { idle: 50, total: 100 })).toBeNull();
    expect(cpuPercentBetween({ idle: 5, total: 100 }, { idle: 0, total: 100 })).toBeNull();
  });
});
