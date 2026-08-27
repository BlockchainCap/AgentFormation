import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./aws", () => ({
  getDocumentClient: () => ({ send }),
}));

import {
  claimUploadCompletion,
  completeUploadClaim,
  registerUploadReservation,
  type UploadReservation,
} from "./upload-admission";

const reservation: UploadReservation = {
  subject: "11111111-1111-4111-8111-111111111111",
  uploadId: "22222222-2222-4222-8222-222222222222",
  objectKey:
    "uploads/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/file.txt",
  filename: "file.txt",
  mimeType: "text/plain",
  fileSize: 12,
  instanceId: "i-0123456789abcdef0",
};

describe("upload completion admission", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    vi.stubEnv("CONTROL_TABLE", "agentformation-control");
  });

  it("registers exact upload metadata before completion", async () => {
    await registerUploadReservation(reservation, 100);

    const request = send.mock.calls[0][0];
    expect(request.constructor.name).toBe("PutCommand");
    expect(request.input.Item).toMatchObject({
      ...reservation,
      status: "pending",
      expiresAt: 700,
    });
  });

  it("atomically claims and completes an upload once", async () => {
    const claim = await claimUploadCompletion(reservation, 100);
    await completeUploadClaim(claim, 200);

    expect(
      send.mock.calls.map(([request]) => request.constructor.name),
    ).toEqual(["UpdateCommand", "UpdateCommand"]);
    expect(send.mock.calls[0][0].input.ConditionExpression).toContain(
      "objectKey = :objectKey",
    );
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":claimExpiresAt": 700,
        ":expiresAt": 1_000,
      },
    );
    expect(send.mock.calls[1][0].input.ExpressionAttributeValues).toMatchObject(
      { ":claimId": claim.claimId, ":completed": "completed" },
    );
  });

  it("rejects an expired, mismatched, or replayed completion", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("conditional"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    await expect(claimUploadCompletion(reservation)).rejects.toMatchObject({
      status: 409,
    });
  });
});
