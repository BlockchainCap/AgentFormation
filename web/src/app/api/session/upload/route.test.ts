import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abandonUploadClaim: vi.fn(),
  acquireOperationLease: vi.fn(),
  claimUploadCompletion: vi.fn(),
  completeUploadClaim: vi.fn(),
  createPresignedPost: vi.fn(),
  enforceRateLimit: vi.fn(),
  readJsonBody: vi.fn(),
  releaseOperationLease: vi.fn(),
  registerUploadReservation: vi.fn(),
  requireAuthorizedRuntime: vi.fn(),
  requireCurrentRuntimeAssignment: vi.fn(),
  requireSameOriginJson: vi.fn(),
  runDocumentCommand: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: mocks.createPresignedPost,
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
  getUploadBucketName: () => "agentformation-uploads",
  getUploadDeliveryDocumentName: () => "agentformation-upload-delivery",
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
vi.mock("@/lib/upload-admission", () => ({
  abandonUploadClaim: mocks.abandonUploadClaim,
  claimUploadCompletion: mocks.claimUploadCompletion,
  completeUploadClaim: mocks.completeUploadClaim,
  registerUploadReservation: mocks.registerUploadReservation,
}));

import { PATCH, POST } from "./route";
import { RuntimeCommandStillRunningError } from "@/lib/ssm-command";

const subject = "00000000-0000-4000-8000-000000000000";
const instanceId = "i-0123456789abcdef0";
const completionBody = {
  key: `uploads/${subject}/22222222-2222-4222-8222-222222222222/notes.txt`,
  filename: "notes.txt",
  mimeType: "text/plain",
  fileSize: 12,
  tmuxSession: "code",
};

function request(method: "PATCH" | "POST" = "POST") {
  return new NextRequest("https://agentformation.example/api/session/upload", {
    method,
    body: JSON.stringify(
      method === "POST"
        ? { filename: "notes.txt", mimeType: "text/plain", fileSize: 12 }
        : completionBody,
    ),
    headers: { "content-type": "application/json" },
  });
}

describe("upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthorizedRuntime.mockResolvedValue({
      subject,
      runtime: { instanceId },
    });
    mocks.requireCurrentRuntimeAssignment.mockResolvedValue(undefined);
    mocks.readJsonBody.mockResolvedValue({
      filename: "notes.txt",
      mimeType: "text/plain",
      fileSize: 12,
    });
    mocks.createPresignedPost.mockResolvedValue({
      url: "https://agentformation-uploads.s3.amazonaws.com",
      fields: { key: "signed-key" },
    });
    mocks.registerUploadReservation.mockResolvedValue(undefined);
    mocks.acquireOperationLease.mockResolvedValue({
      controlKey: "lease-key",
      leaseId: "lease-id",
    });
    mocks.claimUploadCompletion.mockResolvedValue({
      controlKey: "upload-key",
      claimId: "claim-id",
    });
    mocks.completeUploadClaim.mockResolvedValue(undefined);
    mocks.abandonUploadClaim.mockResolvedValue(undefined);
    mocks.releaseOperationLease.mockResolvedValue(undefined);
    mocks.runDocumentCommand.mockResolvedValue("");
    mocks.send.mockResolvedValue({});
  });

  it("enforces the declared size at the S3 upload boundary", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      subject,
      "uploadBytes",
      12,
    );
    expect(mocks.createPresignedPost).toHaveBeenCalledWith(
      { send: mocks.send },
      expect.objectContaining({
        Conditions: expect.arrayContaining([["content-length-range", 12, 12]]),
      }),
    );
  });

  it.each(["__init__.py", "-notes.txt", "文件.txt"])(
    "returns a filename accepted by the fixed delivery document for %s",
    async (filename) => {
      mocks.readJsonBody.mockResolvedValue({
        filename,
        mimeType: "text/plain",
        fileSize: 12,
      });

      const response = await POST(request());
      const body = (await response.json()) as { filename: string };

      expect(body.filename).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
      expect(mocks.registerUploadReservation).toHaveBeenCalledWith(
        expect.objectContaining({ filename: body.filename }),
      );
    },
  );

  it("seals and delivers only the exact reserved object", async () => {
    mocks.readJsonBody.mockResolvedValue(completionBody);
    mocks.send
      .mockResolvedValueOnce({
        ContentLength: 12,
        ContentType: "text/plain",
        ETag: '"etag"',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        ContentLength: 12,
        ContentType: "text/plain",
      })
      .mockResolvedValueOnce({ Errors: [] });

    const response = await PATCH(request("PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.acquireOperationLease).toHaveBeenCalledWith(
      subject,
      "upload-complete",
      instanceId,
      600,
    );
    expect(mocks.claimUploadCompletion).toHaveBeenCalledWith({
      subject,
      uploadId: "22222222-2222-4222-8222-222222222222",
      objectKey: completionBody.key,
      filename: "notes.txt",
      mimeType: "text/plain",
      fileSize: 12,
      instanceId,
    });
    expect(
      mocks.send.mock.calls.map(([command]) => command.constructor.name),
    ).toEqual([
      "HeadObjectCommand",
      "CopyObjectCommand",
      "HeadObjectCommand",
      "DeleteObjectsCommand",
    ]);
    const copyCommand = mocks.send.mock.calls.find(
      ([command]) => command.constructor.name === "CopyObjectCommand",
    )?.[0] as {
      input?: {
        Bucket?: string;
        Key?: string;
        CopySource?: string;
        CopySourceIfMatch?: string;
      };
    };
    expect(copyCommand.input).toMatchObject({
      Bucket: "agentformation-uploads",
      Key: `uploads/${subject}/22222222-2222-4222-8222-222222222222/sealed/notes.txt`,
      CopySource: `agentformation-uploads/uploads/${subject}/22222222-2222-4222-8222-222222222222/notes.txt`,
      CopySourceIfMatch: '"etag"',
    });
    expect(mocks.requireCurrentRuntimeAssignment).toHaveBeenCalledTimes(2);
    expect(mocks.runDocumentCommand).toHaveBeenCalledWith(
      instanceId,
      "agentformation-upload-delivery",
      {
        UploadBucket: ["agentformation-uploads"],
        UserSubject: [subject],
        UploadId: ["22222222-2222-4222-8222-222222222222"],
        Filename: ["notes.txt"],
        TmuxSession: ["code"],
        FileSize: ["12"],
      },
      "Copy AgentFormation upload to assigned runtime",
    );
    expect(mocks.completeUploadClaim).toHaveBeenCalledWith({
      controlKey: "upload-key",
      claimId: "claim-id",
    });
    expect(mocks.abandonUploadClaim).not.toHaveBeenCalled();
  });

  it("rejects a completion key outside the signed-in subject prefix", async () => {
    mocks.readJsonBody.mockResolvedValue({
      ...completionBody,
      key: "uploads/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/notes.txt",
    });

    const response = await PATCH(request("PATCH"));

    expect(response.status).toBe(403);
    expect(mocks.claimUploadCompletion).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.runDocumentCommand).not.toHaveBeenCalled();
  });

  it("retains sealed data when delivery succeeded but claim completion fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.readJsonBody.mockResolvedValue(completionBody);
      mocks.send
        .mockResolvedValueOnce({
          ContentLength: 12,
          ContentType: "text/plain",
          ETag: '"etag"',
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          ContentLength: 12,
          ContentType: "text/plain",
        });
      mocks.completeUploadClaim.mockRejectedValue(new Error("write failed"));

      const response = await PATCH(request("PATCH"));

      expect(response.status).toBe(500);
      expect(mocks.runDocumentCommand).toHaveBeenCalledTimes(1);
      expect(mocks.abandonUploadClaim).not.toHaveBeenCalled();
      expect(
        mocks.send.mock.calls.map(([command]) => command.constructor.name),
      ).toEqual([
        "HeadObjectCommand",
        "CopyObjectCommand",
        "HeadObjectCommand",
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("retains staged data when command completion cannot be confirmed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.readJsonBody.mockResolvedValue(completionBody);
      mocks.send
        .mockResolvedValueOnce({
          ContentLength: 12,
          ContentType: "text/plain",
          ETag: '"etag"',
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          ContentLength: 12,
          ContentType: "text/plain",
        });
      mocks.runDocumentCommand.mockRejectedValue(
        new RuntimeCommandStillRunningError(),
      );

      const response = await PATCH(request("PATCH"));

      expect(response.status).toBe(504);
      expect(
        mocks.send.mock.calls.map(([command]) => command.constructor.name),
      ).toEqual([
        "HeadObjectCommand",
        "CopyObjectCommand",
        "HeadObjectCommand",
      ]);
      expect(mocks.abandonUploadClaim).not.toHaveBeenCalled();
      expect(mocks.releaseOperationLease).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });
});
