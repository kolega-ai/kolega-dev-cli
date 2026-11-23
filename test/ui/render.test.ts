import { describe, expect, it, vi } from "vitest";

import { renderScanResults } from "../../src/ui/render.js";
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

describe("renderScanResults", () => {
  const capture = (fn: () => void): string => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      fn();
    } finally {
      write.mockRestore();
    }
    return chunks.join("");
  };

  const finding = (id: string, status: string) => ({
    id,
    check_id: "js.sqli",
    title: "SQL injection",
    file_path: "app/db.js",
    severity: "high",
    status,
    message: "Unparameterised query",
    cwe: [],
    owasp: [],
    fingerprint: id,
  });

  it("shows each finding's status and the per-status counts", () => {
    const out = capture(() =>
      renderScanResults({
        batch_id: "b1",
        scan_type: "deep_ai_scan",
        status: "completed",
        assessment_complete: true,
        findings_count: 2,
        status_counts: { open: 1, false_positive: 1 },
        findings: [finding("f1", "open"), finding("f2", "false_positive")],
      }),
    );
    expect(out).toContain("2 (1 open, 1 false_positive)");
    expect(out).toContain("false_positive");
    expect(out).not.toContain("aren't final");
  });

  it("warns while assessment is still running", () => {
    const out = capture(() =>
      renderScanResults({
        batch_id: "b1",
        scan_type: "deep_ai_scan",
        status: "assessing",
        assessment_complete: false,
        findings_count: 1,
        status_counts: { open: 1 },
        findings: [finding("f1", "open")],
      }),
    );
    expect(out).toContain("aren't final");
  });
});
