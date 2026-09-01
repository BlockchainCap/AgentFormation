import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./aws", () => ({
  getSsmClient: () => ({ send }),
}));

import {
  runDocumentCommand,
  RuntimeCommandStillRunningError,
} from "./ssm-command";

describe("bounded runtime documents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it("returns only after Systems Manager reports success", async () => {
    send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "SendCommandCommand") {
        return { Command: { CommandId: "command-1" } };
      }
      return { Status: "Success", StandardOutputContent: "done" };
    });

    const command = runDocumentCommand(
      "i-0123456789abcdef0",
      "agentformation-upload-delivery",
      { UploadId: ["22222222-2222-4222-8222-222222222222"] },
      "test",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(command).resolves.toBe("done");
    const sendCommand = send.mock.calls[0][0] as {
      input: { DocumentName?: string; Parameters?: Record<string, string[]> };
    };
    expect(sendCommand.input).toMatchObject({
      DocumentName: "agentformation-upload-delivery",
      Parameters: {
        UploadId: ["22222222-2222-4222-8222-222222222222"],
      },
    });
  });

  it("surfaces a reported command failure without masking it as a timeout", async () => {
    send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "SendCommandCommand") {
        return { Command: { CommandId: "command-1" } };
      }
      return { Status: "Failed" };
    });

    const command = runDocumentCommand(
      "i-0123456789abcdef0",
      "agentformation-upload-delivery",
      { UploadId: ["22222222-2222-4222-8222-222222222222"] },
      "test",
    );
    const rejection = expect(command).rejects.toMatchObject({
      status: 502,
      publicMessage: "Runtime command failed",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(
      send.mock.calls.some(
        ([request]) => request.constructor.name === "CancelCommandCommand",
      ),
    ).toBe(false);
  });

  it("cancels a command when invocation polling cannot be trusted", async () => {
    let invocationChecks = 0;
    send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "SendCommandCommand") {
        return { Command: { CommandId: "command-1" } };
      }
      if (command.constructor.name === "CancelCommandCommand") return {};
      invocationChecks += 1;
      if (invocationChecks === 1) {
        throw Object.assign(new Error("poll failed"), {
          name: "ServiceUnavailableException",
        });
      }
      return { Status: "Cancelled" };
    });

    const command = runDocumentCommand(
      "i-0123456789abcdef0",
      "agentformation-upload-delivery",
      { UploadId: ["22222222-2222-4222-8222-222222222222"] },
      "test",
    );
    const rejection = expect(command).rejects.toThrow("poll failed");
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(
      send.mock.calls.some(
        ([request]) => request.constructor.name === "CancelCommandCommand",
      ),
    ).toBe(true);
  });

  it("reports uncertainty when Systems Manager cannot confirm cancellation", async () => {
    send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "SendCommandCommand") {
        return { Command: { CommandId: "command-1" } };
      }
      if (command.constructor.name === "CancelCommandCommand") {
        throw new Error("cancel response lost");
      }
      throw Object.assign(new Error("poll failed"), {
        name: "ServiceUnavailableException",
      });
    });

    const command = runDocumentCommand(
      "i-0123456789abcdef0",
      "agentformation-oauth-relay",
      { RelayId: ["22222222-2222-4222-8222-222222222222"] },
      "test",
    );
    const rejection = expect(command).rejects.toBeInstanceOf(
      RuntimeCommandStillRunningError,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it("reports uncertainty when the command-start response is lost", async () => {
    send.mockRejectedValue(new Error("request timed out"));

    await expect(
      runDocumentCommand(
        "i-0123456789abcdef0",
        "agentformation-upload-delivery",
        { UploadId: ["22222222-2222-4222-8222-222222222222"] },
        "test",
      ),
    ).rejects.toBeInstanceOf(RuntimeCommandStillRunningError);
  });

  it("reports uncertainty when the command-start response has no command ID", async () => {
    send.mockResolvedValue({ Command: {} });

    await expect(
      runDocumentCommand(
        "i-0123456789abcdef0",
        "agentformation-oauth-relay",
        { RelayId: ["22222222-2222-4222-8222-222222222222"] },
        "test",
      ),
    ).rejects.toBeInstanceOf(RuntimeCommandStillRunningError);
  });

  it("accepts success discovered while confirming cancellation", async () => {
    let invocationChecks = 0;
    send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "SendCommandCommand") {
        return { Command: { CommandId: "command-1" } };
      }
      if (command.constructor.name === "CancelCommandCommand") return {};
      invocationChecks += 1;
      if (invocationChecks === 1) {
        throw Object.assign(new Error("poll failed"), {
          name: "ServiceUnavailableException",
        });
      }
      return { Status: "Success", StandardOutputContent: "done" };
    });

    const command = runDocumentCommand(
      "i-0123456789abcdef0",
      "agentformation-oauth-relay",
      { RelayId: ["22222222-2222-4222-8222-222222222222"] },
      "test",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(command).resolves.toBe("done");
  });

  it("keeps the outcome uncertain when cancellation never becomes terminal", async () => {
    send.mockImplementation(async (command: object) => {
      if (command.constructor.name === "SendCommandCommand") {
        return { Command: { CommandId: "command-1" } };
      }
      if (command.constructor.name === "CancelCommandCommand") return {};
      throw Object.assign(new Error("not visible yet"), {
        name: "InvocationDoesNotExist",
      });
    });

    const command = runDocumentCommand(
      "i-0123456789abcdef0",
      "agentformation-oauth-relay",
      { RelayId: ["22222222-2222-4222-8222-222222222222"] },
      "test",
      { executionTimeoutSeconds: 1 },
    );
    const rejection = expect(command).rejects.toBeInstanceOf(
      RuntimeCommandStillRunningError,
    );
    await vi.advanceTimersByTimeAsync(32_000);
    await rejection;
  });
});
