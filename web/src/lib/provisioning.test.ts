import {
  ExecutionAlreadyExists,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./aws", () => ({
  getSfnClient: () => ({ send: mocks.send }),
}));
vi.mock("./env", () => ({
  getProvisioningStateMachineArn: () =>
    "arn:aws:states:us-east-1:000000000000:stateMachine:test",
}));

import {
  getProvisioningExecutionName,
  getProvisioningInput,
  startRuntimeProvisioning,
} from "./provisioning";

const SUBJECT = "00000000-0000-4000-8000-000000000000";

describe("runtime provisioning", () => {
  beforeEach(() => {
    mocks.send.mockReset();
  });

  it("accepts a federated subject and normalizes its email", () => {
    expect(
      getProvisioningInput(
        SUBJECT,
        "Person@Example.com",
        new Date("2026-08-27T12:00:00.000Z"),
      ),
    ).toEqual({
      subject: SUBJECT,
      email: "person@example.com",
      requestedAt: "2026-08-27T12:00:00.000Z",
      staleBefore: "2026-08-27T10:20:00.000Z",
    });
  });

  it("rejects input that is not a valid federated profile", () => {
    expect(() =>
      getProvisioningInput("not-a-subject", "not-an-email"),
    ).toThrow();
  });

  it("starts one deterministic execution for one exact request", async () => {
    mocks.send.mockResolvedValue({ executionArn: "execution-arn" });
    const now = new Date("2026-08-27T12:00:00.000Z");
    const input = getProvisioningInput(SUBJECT, "Person@Example.com", now);

    await startRuntimeProvisioning(SUBJECT, "Person@Example.com", now);

    const command = mocks.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(StartExecutionCommand);
    expect(command.input).toEqual({
      stateMachineArn:
        "arn:aws:states:us-east-1:000000000000:stateMachine:test",
      name: getProvisioningExecutionName(input),
      input: JSON.stringify(input),
    });
    expect(command.input.name).toMatch(/^provision-[a-f0-9]{64}$/);
  });

  it("treats an existing deterministic execution as the same request", async () => {
    mocks.send.mockRejectedValue(
      new ExecutionAlreadyExists({
        $metadata: {},
        message: "Execution already exists",
      }),
    );

    await expect(
      startRuntimeProvisioning(
        SUBJECT,
        "person@example.com",
        new Date("2026-08-27T12:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not hide other Step Functions failures", async () => {
    mocks.send.mockRejectedValue(new Error("service unavailable"));

    await expect(
      startRuntimeProvisioning(
        SUBJECT,
        "person@example.com",
        new Date("2026-08-27T12:00:00.000Z"),
      ),
    ).rejects.toThrow("service unavailable");
  });
});
