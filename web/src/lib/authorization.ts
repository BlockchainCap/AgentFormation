import { auth } from "./auth";
import { ApiError } from "./api-error";
import { getRuntimeForSubject } from "./registry";
import { canSubjectAccessRuntime, type RuntimeRecord } from "./runtime-access";

export interface AuthorizedRuntime {
  subject: string;
  email: string;
  runtime: RuntimeRecord;
}

export async function requireAuthorizedRuntime(): Promise<AuthorizedRuntime> {
  const session = await auth();
  const subject = session?.user?.id;
  const email = session?.user?.email;
  if (!subject || !email) {
    throw new ApiError(401, "Unauthorized");
  }

  const runtime = await getRuntimeForSubject(subject);
  if (!canSubjectAccessRuntime(subject, runtime)) {
    throw new ApiError(403, "No active runtime assigned");
  }

  return { subject, email, runtime };
}
