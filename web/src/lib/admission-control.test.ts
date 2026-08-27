import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./aws", () => ({
  getDocumentClient: () => ({ send }),
}));

import {
  acquireOperationLease,
  beginIdempotentAction,
  completeIdempotentAction,
  enforceRateLimit,
  releaseOperationLease,
} from "./admission-control";

describe("shared admission control", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    vi.stubEnv("CONTROL_TABLE", "agentformation-control");
  });

  it("uses one shared fixed-window counter for the subject and operation", async () => {
    await enforceRateLimit(
      "11111111-1111-4111-8111-111111111111",
      "sessionStart",
      1,
      120,
    );

    const request = send.mock.calls[0][0];
    expect(request.constructor.name).toBe("UpdateCommand");
    expect(request.input.Key.controlKey).toBe(
      "rate#sessionStart#11111111-1111-4111-8111-111111111111#120",
    );
    expect(request.input.ExpressionAttributeValues[":remaining"]).toBe(19);
  });

  it("returns a controlled 429 when the shared limit is exhausted", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("conditional"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    await expect(
      enforceRateLimit(
        "11111111-1111-4111-8111-111111111111",
        "environmentCreate",
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("releases only the operation lease that it acquired", async () => {
    const lease = await acquireOperationLease(
      "11111111-1111-4111-8111-111111111111",
      "session-start",
      "runtime",
      30,
      100,
    );
    await releaseOperationLease(lease);

    expect(
      send.mock.calls.map(([request]) => request.constructor.name),
    ).toEqual(["PutCommand", "DeleteCommand"]);
    expect(send.mock.calls[1][0].input.ExpressionAttributeValues).toEqual({
      ":leaseId": lease.leaseId,
    });
  });

  it("uses a short pending window before recording a completed action", async () => {
    const action = await beginIdempotentAction(
      "11111111-1111-4111-8111-111111111111",
      "session-terminate",
      "session-id",
      30,
      100,
    );
    await completeIdempotentAction(action, 13 * 60 * 60, 110);

    expect(action).toMatchObject({ acquired: true, completed: false });
    expect(send.mock.calls[0][0].input.Item).toMatchObject({
      actionState: "pending",
      expiresAt: 130,
    });
    expect(send.mock.calls[1][0].constructor.name).toBe("UpdateCommand");
    expect(
      send.mock.calls[1][0].input.ExpressionAttributeValues[":expiresAt"],
    ).toBe(46_910);
  });

  it("recognizes a completed duplicate without repeating the action", async () => {
    send
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        }),
      )
      .mockResolvedValueOnce({
        Item: { actionState: "completed", expiresAt: 1_000 },
      });

    const action = await beginIdempotentAction(
      "11111111-1111-4111-8111-111111111111",
      "session-terminate",
      "session-id",
      30,
      100,
    );

    expect(action).toEqual({ acquired: false, completed: true });
    expect(send.mock.calls[1][0].constructor.name).toBe("GetCommand");
    expect(send.mock.calls[1][0].input.ConsistentRead).toBe(true);
  });

  it.each([
    "ConditionalCheckFailedException",
    "ThrottlingException",
    "TimeoutError",
  ])(
    "does not turn a completed side effect into a failure when its marker write returns %s",
    async (errorName) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        send.mockResolvedValueOnce({}).mockRejectedValueOnce(
          Object.assign(new Error("conditional"), {
            name: errorName,
          }),
        );
        const action = await beginIdempotentAction(
          "11111111-1111-4111-8111-111111111111",
          "session-terminate",
          "session-id",
          120,
          100,
        );

        await expect(
          completeIdempotentAction(action, 13 * 60 * 60, 110),
        ).resolves.toBeUndefined();
        expect(errorLog).toHaveBeenCalledWith(
          "admission.completion.marker.failed",
          { errorType: errorName },
        );
      } finally {
        errorLog.mockRestore();
      }
    },
  );
});
