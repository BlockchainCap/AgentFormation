import { createHash } from "node:crypto";
import {
  ExecutionAlreadyExists,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { z } from "zod";
import { getSfnClient } from "./aws";
import { getProvisioningStateMachineArn } from "./env";

const provisioningInputSchema = z.object({
  subject: z.string().uuid(),
  email: z
    .string()
    .email()
    .transform((email) => email.toLowerCase()),
  requestedAt: z.string().datetime({ precision: 3 }),
  staleBefore: z.string().datetime({ precision: 3 }),
});

// The Step Functions definition has a 90-minute hard timeout. Keep retry
// eligibility later than that deadline so an old execution cannot overlap a
// replacement that owns the same deterministic runtime stack name.
export const PROVISIONING_STALE_AFTER_MS = 100 * 60 * 1_000;

export function getProvisioningInput(
  subject: string,
  email: string,
  now = new Date(),
) {
  return provisioningInputSchema.parse({
    subject,
    email,
    requestedAt: now.toISOString(),
    staleBefore: new Date(
      now.getTime() - PROVISIONING_STALE_AFTER_MS,
    ).toISOString(),
  });
}

export function getProvisioningExecutionName(
  input: z.infer<typeof provisioningInputSchema>,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.subject,
        input.email,
        input.requestedAt,
        input.staleBefore,
      ]),
    )
    .digest("hex");
  return `provision-${digest}`;
}

export async function startRuntimeProvisioning(
  subject: string,
  email: string,
  now = new Date(),
): Promise<void> {
  const input = getProvisioningInput(subject, email, now);
  try {
    await getSfnClient().send(
      new StartExecutionCommand({
        stateMachineArn: getProvisioningStateMachineArn(),
        name: getProvisioningExecutionName(input),
        input: JSON.stringify(input),
      }),
    );
  } catch (error) {
    if (
      error instanceof ExecutionAlreadyExists ||
      (error instanceof Error && error.name === "ExecutionAlreadyExists")
    ) {
      return;
    }
    throw error;
  }
}
