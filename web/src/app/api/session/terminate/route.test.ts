import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginIdempotentAction: vi.fn(),
  cancelIdempotentAction: vi.fn(),
  completeIdempotentAction: vi.fn(),
  enforceRateLimit: vi.fn(),
  readJsonBody: vi.fn(),
  requireAuthorizedRuntime: vi.fn(),
  requireCurrentRuntimeAssignment: vi.fn(),
  requireSameOriginJson: vi.fn(),
  send: vi.fn(),
  verifyTerminateToken: vi.fn(),
}));

vi.mock("@/lib/admission-control", () => ({
  beginIdempotentAction: mocks.beginIdempotentAction,
  cancelIdempotentAction: mocks.cancelIdempotentAction,
  completeIdempotentAction: mocks.completeIdempotentAction,
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock("@/lib/authorization", () => ({
  requireAuthorizedRuntime: mocks.requireAuthorizedRuntime,
  requireCurrentRuntimeAssignment: mocks.requireCurrentRuntimeAssignment,
}));
vi.mock("@/lib/aws", () => ({
  AWS_MUTATION_GUARD_TTL_SECONDS: 120,
  getSsmClient: () => ({ send: mocks.send }),
}));
vi.mock("@/lib/request-security", () => ({
  readJsonBody: mocks.readJsonBody,
  requireSameOriginJson: mocks.requireSameOriginJson,
}));
vi.mock("@/lib/session-proof", () => ({
  SESSION_CONTROL_TOKEN_TTL_SECONDS: 46_800,
  verifyTerminateToken: mocks.verifyTerminateToken,
}));

import { POST } from "./route";

const subject = "00000000-0000-4000-8000-000000000000";
const instanceId = "i-0123456789abcdef0";
const body = { sessionId: "session-123", terminateToken: "proof" };

function request() {
  return new NextRequest(
    "https://agentformation.example/api/session/terminate",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

describe("session termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthorizedRuntime.mockResolvedValue({
      subject,
      runtime: { instanceId },
    });
    mocks.readJsonBody.mockResolvedValue(body);
    mocks.verifyTerminateToken.mockReturnValue(true);
    mocks.requireCurrentRuntimeAssignment.mockResolvedValue(undefined);
    mocks.beginIdempotentAction.mockResolvedValue({
      acquired: true,
      completed: false,
      lease: { controlKey: "once-key", leaseId: "lease-id" },
    });
    mocks.send.mockResolvedValue({ SessionId: body.sessionId });
    mocks.completeIdempotentAction.mockResolvedValue(undefined);
  });

  it("uses a guard longer than the AWS request budget", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.beginIdempotentAction).toHaveBeenCalledWith(
      subject,
      "session-terminate",
      body.sessionId,
      120,
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.completeIdempotentAction).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an action already recorded as complete", async () => {
    mocks.beginIdempotentAction.mockResolvedValue({
      acquired: false,
      completed: true,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.cancelIdempotentAction).not.toHaveBeenCalled();
  });

  it("fails closed and releases the marker when AWS does not confirm termination", async () => {
    mocks.send.mockRejectedValue(
      Object.assign(new Error("unavailable"), {
        name: "InternalServerError",
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.completeIdempotentAction).not.toHaveBeenCalled();
    expect(mocks.cancelIdempotentAction).toHaveBeenCalledTimes(1);
  });
});
