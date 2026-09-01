import { TerminateSessionCommand } from "@aws-sdk/client-ssm";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  beginIdempotentAction,
  cancelIdempotentAction,
  completeIdempotentAction,
  enforceRateLimit,
  type IdempotentAction,
} from "@/lib/admission-control";
import { ApiError, apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import {
  requireAuthorizedRuntime,
  requireCurrentRuntimeAssignment,
} from "@/lib/authorization";
import { AWS_MUTATION_GUARD_TTL_SECONDS, getSsmClient } from "@/lib/aws";
import { readJsonBody, requireSameOriginJson } from "@/lib/request-security";
import {
  SESSION_CONTROL_TOKEN_TTL_SECONDS,
  verifyTerminateToken,
} from "@/lib/session-proof";

const requestSchema = z
  .object({
    sessionId: z.string().min(1).max(96),
    terminateToken: z.string().min(1).max(512),
  })
  .strict();

export async function POST(request: NextRequest) {
  let action: IdempotentAction | undefined;
  let terminationFinished = false;
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
    await enforceRateLimit(subject, "sessionTerminate");
    await requireCurrentRuntimeAssignment(subject, runtime.instanceId);
    action = await beginIdempotentAction(
      subject,
      "session-terminate",
      body.sessionId,
      AWS_MUTATION_GUARD_TTL_SECONDS,
    );
    if (!action.acquired) {
      if (action.completed) return apiJsonResponse({ ok: true });
      throw new ApiError(429, "Session termination is already being handled");
    }

    await getSsmClient().send(
      new TerminateSessionCommand({ SessionId: body.sessionId }),
    );
    terminationFinished = true;
    await completeIdempotentAction(action, SESSION_CONTROL_TOKEN_TTL_SECONDS);
    return apiJsonResponse({ ok: true });
  } catch (error) {
    if (action?.acquired && !terminationFinished) {
      await cancelIdempotentAction(action);
    }
    return apiErrorResponse(error, "session.terminate.failed");
  }
}
