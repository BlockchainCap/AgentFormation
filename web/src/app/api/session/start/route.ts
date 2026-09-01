import {
  StartSessionCommand,
  TerminateSessionCommand,
} from "@aws-sdk/client-ssm";
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
import { getSessionDocumentName } from "@/lib/env";
import { readJsonBody, requireSameOriginJson } from "@/lib/request-security";
import { createTerminateToken } from "@/lib/session-proof";
import { validateSsmSessionResponse } from "@/lib/ssm-session-response";

const requestSchema = z
  .object({
    tmuxSession: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default("code"),
    termOptions: z
      .object({
        cols: z.number().int().min(20).max(240),
        rows: z.number().int().min(5).max(200),
      })
      .optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  let startedSessionId: string | undefined;
  let sessionReturned = false;
  let cleanupPromise: Promise<void> | undefined;
  let admissionLease: OperationLease | undefined;
  const cleanupStartedSession = () => {
    if (!startedSessionId) return Promise.resolve();
    cleanupPromise ??= getSsmClient()
      .send(new TerminateSessionCommand({ SessionId: startedSessionId }))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error("session.start.cleanup.failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      });
    return cleanupPromise;
  };
  const handleRequestAbort = () => {
    if (!sessionReturned) void cleanupStartedSession();
  };
  request.signal.addEventListener("abort", handleRequestAbort, { once: true });

  try {
    requireSameOriginJson(request);
    const { subject, runtime } = await requireAuthorizedRuntime();
    const body = requestSchema.parse(await readJsonBody(request));
    await enforceRateLimit(subject, "sessionStart");
    admissionLease = await acquireOperationLease(
      subject,
      "session-start",
      "runtime",
      AWS_MUTATION_GUARD_TTL_SECONDS,
    );
    await requireCurrentRuntimeAssignment(subject, runtime.instanceId);
    const response = await getSsmClient().send(
      new StartSessionCommand({
        Target: runtime.instanceId,
        DocumentName: getSessionDocumentName(),
        Parameters: { tmuxSession: [body.tmuxSession] },
        Reason: "AgentFormation browser terminal",
      }),
    );

    // Capture the raw ID before validating the rest of AWS's response so a
    // malformed stream URL or token can still be compensated.
    if (typeof response.SessionId === "string" && response.SessionId) {
      startedSessionId = response.SessionId;
    }

    const session = validateSsmSessionResponse(response);
    if (request.signal.aborted) {
      await cleanupStartedSession();
      throw new ApiError(408, "Session request was cancelled");
    }

    const result = apiJsonResponse({
      sessionId: session.sessionId,
      streamUrl: session.streamUrl,
      tokenValue: session.tokenValue,
      terminateToken: createTerminateToken(
        subject,
        session.sessionId,
        runtime.instanceId,
      ),
    });
    await releaseOperationLease(admissionLease);
    admissionLease = undefined;
    if (request.signal.aborted) {
      await cleanupStartedSession();
      throw new ApiError(408, "Session request was cancelled");
    }
    request.signal.removeEventListener("abort", handleRequestAbort);
    sessionReturned = true;
    return result;
  } catch (error) {
    if (startedSessionId && !sessionReturned) {
      await cleanupStartedSession();
    }
    return apiErrorResponse(error, "session.start.failed");
  } finally {
    request.signal.removeEventListener("abort", handleRequestAbort);
    if (admissionLease) await releaseOperationLease(admissionLease);
  }
}
