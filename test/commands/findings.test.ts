import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { registerFindingsCommands } from "../../src/commands/findings.js";

const BASE = "https://api.example.test";
const FINDING_PATH = "/api/v1/repositories/repo-1/findings/f-9";
let mockAgent: MockAgent;
const origDispatcher = getGlobalDispatcher();
const origToken = process.env.KOLEGA_TOKEN;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  process.env.KOLEGA_TOKEN = "kcp_live_test";
});

afterEach(async () => {
  if (origToken === undefined) {
    delete process.env.KOLEGA_TOKEN;
  } else {
    process.env.KOLEGA_TOKEN = origToken;
  }
  await mockAgent.close();
  setGlobalDispatcher(origDispatcher);
  vi.restoreAllMocks();
});

function makeProgram(): Command {
  const program = new Command();
  program
    .name("kolega")
    .exitOverride()
    .option("--api-url <url>", "override the API base URL")
    .option("--json", "emit raw JSON to stdout instead of a formatted table");
  registerFindingsCommands(program, "0.1.0");
  return program;
}

function setStatus(...args: string[]): Promise<Command> {
  return makeProgram().parseAsync([
    "node",
    "kolega",
    "--api-url",
    BASE,
    "findings",
    "set-status",
    "repo-1",
    "f-9",
    ...args,
  ]);
}

/** Answer the status PATCH with the updated finding and capture the request body. */
function interceptStatusUpdate(): { body: () => unknown } {
  let captured: unknown;
  mockAgent
    .get(BASE)
    .intercept({ path: FINDING_PATH, method: "PATCH" })
    .reply((req) => {
      captured = JSON.parse(String(req.body));
      return {
        statusCode: 200,
        data: JSON.stringify({ id: "f-9", status: (captured as { status: string }).status }),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    });
  return { body: () => captured };
}

function exitThrows(): void {
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit:${code ?? ""}`);
  });
}

describe("findings set-status", () => {
  it("sends only the status when no reason is given", async () => {
    const request = interceptStatusUpdate();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await setStatus("ignored");

    expect(request.body()).toEqual({ status: "ignored" });
    expect(stdoutWrite.mock.calls.join("")).toContain("f-9");
    mockAgent.assertNoPendingInterceptors();
  });

  it("sends the trimmed --reason with the status", async () => {
    const request = interceptStatusUpdate();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await setStatus("false_positive", "--reason", "  Input is validated upstream  ");

    expect(request.body()).toEqual({
      status: "false_positive",
      reason: "Input is validated upstream",
    });
  });

  it("treats a blank --reason as no reason", async () => {
    const request = interceptStatusUpdate();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await setStatus("ignored", "--reason", "   ");

    expect(request.body()).toEqual({ status: "ignored" });
  });

  it("points to --reason when the organization requires one", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: FINDING_PATH, method: "PATCH" })
      .reply(
        400,
        {
          detail: {
            detail: "A reason is required to close a finding in this organization.",
            error_code: "FINDING_CLOSURE_REASON_REQUIRED",
          },
        },
        { headers: { "content-type": "application/json" } },
      );
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitThrows();

    await expect(setStatus("ignored")).rejects.toThrow("process.exit:5");

    const output = stderrWrite.mock.calls.join("");
    expect(output).toContain("A reason is required to close a finding in this organization.");
    expect(output).toContain("--reason");
  });

  it("rejects an overlong --reason before calling the API", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitThrows();

    // No interceptor is registered, so any request would fail the test.
    await expect(setStatus("ignored", "--reason", "x".repeat(1001))).rejects.toThrow(
      "process.exit:1",
    );

    expect(stderrWrite.mock.calls.join("")).toContain("--reason is too long");
  });
});
