import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { z } from "zod";
import { getSfnClient } from "./aws";
import { getProvisioningStateMachineArn } from "./env";

const provisioningInputSchema = z.object({
  subject: z.string().uuid(),
  email: z
    .string()
    .email()
    .transform((email) => email.toLowerCase()),
});

export function getProvisioningInput(subject: string, email: string) {
  return provisioningInputSchema.parse({ subject, email });
}

export async function startRuntimeProvisioning(
  subject: string,
  email: string,
): Promise<void> {
  const input = getProvisioningInput(subject, email);
  await getSfnClient().send(
    new StartExecutionCommand({
      stateMachineArn: getProvisioningStateMachineArn(),
      input: JSON.stringify(input),
    }),
  );
}
