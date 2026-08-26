import { TerminateSessionCommand } from "@aws-sdk/client-ssm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import { requireAuthorizedRuntime } from "@/lib/authorization";
import { getSsmClient } from "@/lib/aws";
import { requireSameOriginJson } from "@/lib/request-security";
import { verifyTerminateToken } from "@/lib/session-proof";

const requestSchema = z.object({
  sessionId: z.string().min(1).max(256),
  terminateToken: z.string().min(1).max(256),
});

export async function POST(request: NextRequest) {
  try {
    requireSameOriginJson(request);
    const { subject } = await requireAuthorizedRuntime();
    const body = requestSchema.parse(await request.json());
    if (!verifyTerminateToken(subject, body.sessionId, body.terminateToken)) {
      throw new ApiError(403, "Forbidden");
    }

    await getSsmClient().send(
      new TerminateSessionCommand({ SessionId: body.sessionId }),
    );
    return apiJsonResponse({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, "session.terminate.failed");
  }
}
