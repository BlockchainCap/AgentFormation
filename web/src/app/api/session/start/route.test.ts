import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireOperationLease: vi.fn(),
  createTerminateToken: vi.fn(),
  enforceRateLimit: vi.fn(),
  readJsonBody: vi.fn(),
  releaseOperationLease: vi.fn(),
  requireAuthorizedRuntime: vi.fn(),
  requireCurrentRuntimeAssignment: vi.fn(),
  requireSameOriginJson: vi.fn(),
  send: vi.fn(),
  validateSsmSessionResponse: vi.fn(),
}));

vi.mock("@/lib/admission-control", () => ({
  acquireOperationLease: mocks.acquireOperationLease,
  enforceRateLimit: mocks.enforceRateLimit,
  releaseOperationLease: mocks.releaseOperationLease,
}));
vi.mock("@/lib/authorization", () => ({
  requireAuthorizedRuntime: mocks.requireAuthorizedRuntime,
  requireCurrentRuntimeAssignment: mocks.requireCurrentRuntimeAssignment,
}));
vi.mock("@/lib/aws", () => ({
  AWS_MUTATION_GUARD_TTL_SECONDS: 120,
  getSsmClient: () => ({ send: mocks.send }),
}));
vi.mock("@/lib/env", () => ({
  getSessionDocumentName: () => "agentformation-terminal",
}));
vi.mock("@/lib/request-security", () => ({
  readJsonBody: mocks.readJsonBody,
  requireSameOriginJson: mocks.requireSameOriginJson,
}));
vi.mock("@/lib/session-proof", () => ({
  createTerminateToken: mocks.createTerminateToken,
}));
vi.mock("@/lib/ssm-session-response", () => ({
  validateSsmSessionResponse: mocks.validateSsmSessionResponse,
}));

import { POST } from "./route";

const subject = "00000000-0000-4000-8000-000000000000";
const instanceId = "i-0123456789abcdef0";

function request(signal?: AbortSignal) {
  const nextRequest = new NextRequest(
    "https://agentformation.example/api/session/start",
    {
      method: "POST",
      body: JSON.stringify({ tmuxSession: "code" }),
      headers: { "content-type": "application/json" },
    },
  );
  if (signal) {
    Object.defineProperty(nextRequest, "signal", { value: signal });
  }
  return nextRequest;
}

describe("session start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthorizedRuntime.mockResolvedValue({
      subject,
      runtime: { instanceId },
    });
    mocks.readJsonBody.mockResolvedValue({ tmuxSession: "code" });
    mocks.acquireOperationLease.mockResolvedValue({
      controlKey: "lease-key",
      leaseId: "lease-id",
    });
    mocks.requireCurrentRuntimeAssignment.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue({ SessionId: "session-123" });
    mocks.validateSsmSessionResponse.mockReturnValue({
      sessionId: "session-123",
      streamUrl:
        "wss://ssmmessages.us-east-1.amazonaws.com/v1/data-channel/session-123",
      tokenValue: "token-value",
    });
    mocks.createTerminateToken.mockReturnValue("termination-proof");
    mocks.releaseOperationLease.mockResolvedValue(undefined);
  });

  it("hands a valid session to the browser without terminating it", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].constructor.name).toBe(
      "StartSessionCommand",
    );
    expect(mocks.releaseOperationLease).toHaveBeenCalledTimes(1);
  });

  it("terminates a session when the request aborts before handoff", async () => {
    const controller = new AbortController();
    mocks.releaseOperationLease.mockImplementationOnce(async () => {
      controller.abort();
    });

    const response = await POST(request(controller.signal));

    expect(response.status).toBe(408);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1][0].constructor.name).toBe(
      "TerminateSessionCommand",
    );
  });

  it("does not terminate a session after successful handoff", async () => {
    const controller = new AbortController();

    const response = await POST(request(controller.signal));
    controller.abort();
    await Promise.resolve();

    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("terminates an AWS session when response validation fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.send
        .mockResolvedValueOnce({ SessionId: "session-123" })
        .mockResolvedValueOnce({ SessionId: "session-123" });
      mocks.validateSsmSessionResponse.mockImplementation(() => {
        throw new Error("Unexpected SSM stream URL");
      });

      const response = await POST(request());

      expect(response.status).toBe(500);
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(mocks.send.mock.calls[1][0].constructor.name).toBe(
        "TerminateSessionCommand",
      );
      expect(mocks.send.mock.calls[1][0].input).toEqual({
        SessionId: "session-123",
      });
      expect(mocks.acquireOperationLease).toHaveBeenCalledWith(
        subject,
        "session-start",
        "runtime",
        120,
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("logs when compensating termination cannot be confirmed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.send
        .mockResolvedValueOnce({ SessionId: "session-123" })
        .mockRejectedValueOnce(
          Object.assign(new Error("cleanup failed"), {
            name: "InternalServerError",
          }),
        );
      mocks.validateSsmSessionResponse.mockImplementation(() => {
        throw new Error("Unexpected SSM stream URL");
      });

      const response = await POST(request());

      expect(response.status).toBe(500);
      expect(errorLog).toHaveBeenCalledWith("session.start.cleanup.failed", {
        errorType: "InternalServerError",
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
