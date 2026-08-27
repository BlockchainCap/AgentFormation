import { ResumeSessionCommand } from "@aws-sdk/client-ssm";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  acquireOperationLease,
  enforceRateLimit,
  releaseOperationLease,
  type OperationLease,
} from "@/lib/admission-control";
import { ApiError, apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import {
  requireAuthorizedRuntime,
  requireCurrentRuntimeAssignment,
} from "@/lib/authorization";
import { AWS_MUTATION_GUARD_TTL_SECONDS, getSsmClient } from "@/lib/aws";
import { readJsonBody, requireSameOriginJson } from "@/lib/request-security";
import { verifyTerminateToken } from "@/lib/session-proof";
import { validateSsmSessionResponse } from "@/lib/ssm-session-response";

const requestSchema = z
  .object({
    sessionId: z.string().min(1).max(96),
    terminateToken: z.string().min(1).max(512),
  })
  .strict();

export async function POST(request: NextRequest) {
  let lease: OperationLease | undefined;
  try {
    requireSameOriginJson(request);
    const { subject, runtime } = await requireAuthorizedRuntime();
    const body = requestSchema.parse(await readJsonBody(request));
    if (
      !verifyTerminateToken(
        subject,
        body.sessionId,
        runtime.instanceId,
        body.terminateToken,
      )
    ) {
      throw new ApiError(403, "Forbidden");
    }
    await enforceRateLimit(subject, "sessionResume");
    lease = await acquireOperationLease(
      subject,
      "session-resume",
      body.sessionId,
      AWS_MUTATION_GUARD_TTL_SECONDS,
    );
    await requireCurrentRuntimeAssignment(subject, runtime.instanceId);

    const response = await getSsmClient().send(
      new ResumeSessionCommand({ SessionId: body.sessionId }),
    );
    const session = validateSsmSessionResponse(response, body.sessionId);

    return apiJsonResponse({
      sessionId: session.sessionId,
      streamUrl: session.streamUrl,
      tokenValue: session.tokenValue,
      terminateToken: body.terminateToken,
    });
  } catch (error) {
    return apiErrorResponse(error, "session.resume.failed");
  } finally {
    await releaseOperationLease(lease);
  }
}
