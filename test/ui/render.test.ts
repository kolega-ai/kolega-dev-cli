import { describe, expect, it } from "vitest";
import { redactToken, box } from "../../src/ui/tty.js";

describe("tty helpers", () => {
  it("redacts a live token to prefix plus 5 chars of suffix", () => {
    expect(redactToken("kcp_live_abcdefghij1234567890")).toBe("kcp_live_…abcde");
  });

  it("redacts a test token identifier", () => {
    expect(redactToken("kcp_test_xyz9876")).toBe("kcp_test_…xyz98");
  });

  it("falls back gracefully on non-kcp tokens", () => {
    expect(redactToken("something-weird")).toBe("some…");
  });

  it("draws a box wide enough for the widest line", () => {
    const b = box(["abc", "longer line"]);
    const lines = b.split("\n");
    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("┐");
    expect(lines[lines.length - 1]).toContain("└");
    expect(lines[lines.length - 1]).toContain("┘");
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith("│")).toBe(true);
      expect(line.endsWith("│")).toBe(true);
    }
  });
});
