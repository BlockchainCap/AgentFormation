import { auth } from "./auth";
import { z } from "zod";
import { ApiError } from "./api-error";
import { getRuntimeForSubject } from "./registry";
import {
  canSubjectAccessRuntime,
  type ActiveRuntimeRecord,
} from "./runtime-access";

export interface AuthorizedRuntime {
  subject: string;
  email: string;
  runtime: ActiveRuntimeRecord;
}

export interface AuthenticatedIdentity {
  subject: string;
  email: string;
}

const authenticatedIdentitySchema = z.object({
  subject: z.string().uuid(),
  email: z
    .string()
    .email()
    .transform((email) => email.toLowerCase()),
});

export async function requireAuthenticatedIdentity(): Promise<AuthenticatedIdentity> {
  const session = await auth();
  const subject = session?.user?.id;
  const email = session?.user?.email;
  const identity = authenticatedIdentitySchema.safeParse({ subject, email });
  if (!identity.success) {
    throw new ApiError(401, "Unauthorized");
  }
  return identity.data;
}

export async function requireAuthorizedRuntime(): Promise<AuthorizedRuntime> {
  const { subject, email } = await requireAuthenticatedIdentity();

  const runtime = await getRuntimeForSubject(subject);
  if (!canSubjectAccessRuntime(subject, runtime)) {
    throw new ApiError(403, "No active runtime assigned");
  }

  return { subject, email, runtime };
}

export async function requireCurrentRuntimeAssignment(
  subject: string,
  expectedInstanceId: string,
): Promise<ActiveRuntimeRecord> {
  const runtime = await getRuntimeForSubject(subject);
  if (
    !canSubjectAccessRuntime(subject, runtime) ||
    runtime.instanceId !== expectedInstanceId
  ) {
    throw new ApiError(403, "Runtime access changed; try again");
  }
  return runtime;
}
