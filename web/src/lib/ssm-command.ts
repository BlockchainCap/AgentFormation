import {
  GetCommandInvocationCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import { ApiError } from "./api-error";
import { getSsmClient } from "./aws";

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;
const terminalStatuses = new Set([
  "Cancelled",
  "Cancelling",
  "Failed",
  "TimedOut",
]);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export async function runShellCommand(
  instanceId: string,
  commands: readonly string[],
  comment: string,
): Promise<string> {
  const ssm = getSsmClient();
  const response = await ssm.send(
    new SendCommandCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [instanceId],
      Parameters: { commands: [...commands], executionTimeout: ["120"] },
      TimeoutSeconds: 130,
      Comment: comment,
    }),
  );
  const commandId = response.Command?.CommandId;
  if (!commandId) {
    throw new ApiError(502, "Runtime command did not start");
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const invocation = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }),
      );
      if (invocation.Status === "Success") {
        return invocation.StandardOutputContent ?? "";
      }
      if (invocation.Status && terminalStatuses.has(invocation.Status)) {
        throw new ApiError(502, "Runtime command failed");
      }
    } catch (error) {
      if (errorName(error) !== "InvocationDoesNotExist") {
        throw error;
      }
    }
  }

  throw new ApiError(504, "Runtime command timed out");
}
