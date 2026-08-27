import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  type GetCommandInvocationCommandOutput,
} from "@aws-sdk/client-ssm";
import { ApiError } from "./api-error";
import { getSsmClient } from "./aws";

const POLL_INTERVAL_MS = 1_000;
const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 60;
const POLL_GRACE_MS = 15_000;
const CANCELLATION_CONFIRMATION_MS = 15_000;
const terminalStatuses = new Set(["Cancelled", "Failed", "TimedOut"]);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export class RuntimeCommandStillRunningError extends ApiError {
  constructor() {
    super(504, "Runtime command state could not be confirmed");
    this.name = "RuntimeCommandStillRunningError";
  }
}

interface RunDocumentCommandOptions {
  executionTimeoutSeconds?: number;
}

export async function runDocumentCommand(
  instanceId: string,
  documentName: string,
  parameters: Readonly<Record<string, readonly string[]>>,
  comment: string,
  options: RunDocumentCommandOptions = {},
): Promise<string> {
  const ssm = getSsmClient();
  const executionTimeoutSeconds =
    options.executionTimeoutSeconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS;
  let response;
  try {
    response = await ssm.send(
      new SendCommandCommand({
        DocumentName: documentName,
        InstanceIds: [instanceId],
        Parameters: Object.fromEntries(
          Object.entries(parameters).map(([name, values]) => [
            name,
            [...values],
          ]),
        ),
        TimeoutSeconds: executionTimeoutSeconds + 10,
        Comment: comment,
      }),
    );
  } catch {
    // Systems Manager may have accepted the command even when its response was
    // lost. The caller must retain any staged input until its guard expires.
    throw new RuntimeCommandStillRunningError();
  }
  const commandId = response.Command?.CommandId;
  if (!commandId) {
    throw new RuntimeCommandStillRunningError();
  }

  const deadline = Date.now() + executionTimeoutSeconds * 1_000 + POLL_GRACE_MS;
  let pollingError: unknown;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let invocation: GetCommandInvocationCommandOutput;
    try {
      invocation = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }),
      );
    } catch (error) {
      if (errorName(error) !== "InvocationDoesNotExist") {
        pollingError = error;
        break;
      }
      continue;
    }
    if (invocation.Status === "Success") {
      return invocation.StandardOutputContent ?? "";
    }
    if (invocation.Status && terminalStatuses.has(invocation.Status)) {
      throw new ApiError(502, "Runtime command failed");
    }
  }

  try {
    await ssm.send(
      new CancelCommandCommand({
        CommandId: commandId,
        InstanceIds: [instanceId],
      }),
    );
  } catch {
    throw new RuntimeCommandStillRunningError();
  }
  const cancellationDeadline = Date.now() + CANCELLATION_CONFIRMATION_MS;
  while (Date.now() < cancellationDeadline) {
    await sleep(POLL_INTERVAL_MS);
    let invocation: GetCommandInvocationCommandOutput;
    try {
      invocation = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }),
      );
    } catch (error) {
      if (errorName(error) !== "InvocationDoesNotExist") {
        throw new RuntimeCommandStillRunningError();
      }
      continue;
    }
    if (invocation.Status === "Success") {
      return invocation.StandardOutputContent ?? "";
    }
    if (invocation.Status && terminalStatuses.has(invocation.Status)) {
      if (pollingError) throw pollingError;
      throw new ApiError(504, "Runtime command timed out");
    }
  }

  throw new RuntimeCommandStillRunningError();
}
