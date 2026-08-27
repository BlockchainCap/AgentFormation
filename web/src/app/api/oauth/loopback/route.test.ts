import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireOperationLease: vi.fn(),
  enforceRateLimit: vi.fn(),
  readJsonBody: vi.fn(),
  releaseOperationLease: vi.fn(),
  requireAuthorizedRuntime: vi.fn(),
  requireCurrentRuntimeAssignment: vi.fn(),
  requireSameOriginJson: vi.fn(),
  runDocumentCommand: vi.fn(),
  send: vi.fn(),
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
  AWS_REMOTE_COMMAND_GUARD_TTL_SECONDS: 600,
  getS3Client: () => ({ send: mocks.send }),
}));
vi.mock("@/lib/env", () => ({
  getOAuthRelayDocumentName: () => "agentformation-oauth-relay",
  getUploadBucketName: () => "agentformation-uploads",
}));
vi.mock("@/lib/request-security", () => ({
  readJsonBody: mocks.readJsonBody,
  requireSameOriginJson: mocks.requireSameOriginJson,
}));
vi.mock("@/lib/ssm-command", async () => {
  const { ApiError } =
    await vi.importActual<typeof import("@/lib/api-error")>("@/lib/api-error");
  return {
    RuntimeCommandStillRunningError: class extends ApiError {
      constructor() {
        super(504, "Runtime command state could not be confirmed");
      }
    },
    runDocumentCommand: mocks.runDocumentCommand,
  };
});

import { POST } from "./route";
import { RuntimeCommandStillRunningError } from "@/lib/ssm-command";

const subject = "00000000-0000-4000-8000-000000000000";
const instanceId = "i-0123456789abcdef0";
const callbackUrl =
  "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&state=state";

function request() {
  return new NextRequest("https://agentformation.example/api/oauth/loopback", {
    method: "POST",
    body: JSON.stringify({ callbackUrl }),
    headers: { "content-type": "application/json" },
  });
}

describe("OAuth callback relay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthorizedRuntime.mockResolvedValue({
      subject,
      runtime: { instanceId },
    });
    mocks.requireCurrentRuntimeAssignment.mockResolvedValue(undefined);
    mocks.readJsonBody.mockResolvedValue({ callbackUrl });
    mocks.acquireOperationLease.mockResolvedValue({
      controlKey: "lease-key",
      leaseId: "lease-id",
    });
    mocks.releaseOperationLease.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue({});
    mocks.runDocumentCommand.mockResolvedValue("");
  });

  it("holds a cross-instance lease through the bounded remote command", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.acquireOperationLease).toHaveBeenCalledWith(
      subject,
      "oauth-relay",
      instanceId,
      600,
    );
    expect(mocks.requireCurrentRuntimeAssignment).toHaveBeenCalledWith(
      subject,
      instanceId,
    );
    expect(mocks.runDocumentCommand).toHaveBeenCalledWith(
      instanceId,
      "agentformation-oauth-relay",
      {
        UploadBucket: ["agentformation-uploads"],
        UserSubject: [subject],
        RelayId: [expect.stringMatching(/^[0-9a-f-]{36}$/)],
      },
      "Relay AgentFormation OAuth loopback callback",
    );
    expect(mocks.releaseOperationLease).toHaveBeenCalledWith({
      controlKey: "lease-key",
      leaseId: "lease-id",
    });
    expect(
      mocks.send.mock.calls.map(([command]) => command.constructor.name),
    ).toEqual(["PutObjectCommand", "DeleteObjectCommand"]);
  });

  it("retains the callback and lease while command completion is uncertain", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.runDocumentCommand.mockRejectedValue(
        new RuntimeCommandStillRunningError(),
      );

      const response = await POST(request());

      expect(response.status).toBe(504);
      expect(
        mocks.send.mock.calls.map(([command]) => command.constructor.name),
      ).toEqual(["PutObjectCommand"]);
      expect(mocks.releaseOperationLease).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a confirmed success when staging cleanup fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "DeleteObjectCommand") {
        throw Object.assign(new Error("private provider detail"), {
          name: "ServiceUnavailableException",
        });
      }
      return {};
    });
    try {
      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(errorLog).toHaveBeenCalledWith(
        "OAuth callback staging cleanup failed",
        { errorName: "ServiceUnavailableException" },
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(callbackUrl);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a confirmed success when lease release fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.releaseOperationLease.mockRejectedValue(
      Object.assign(new Error("private provider detail"), {
        name: "ServiceUnavailableException",
      }),
    );
    try {
      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(errorLog).toHaveBeenCalledWith(
        "OAuth callback lease release failed",
        { errorName: "ServiceUnavailableException" },
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(callbackUrl);
    } finally {
      errorLog.mockRestore();
    }
  });
});
