import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  acquireOperationLease,
  enforceRateLimit,
  releaseOperationLease,
  type OperationLease,
} from "@/lib/admission-control";
import { apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import {
  requireAuthorizedRuntime,
  requireCurrentRuntimeAssignment,
} from "@/lib/authorization";
import { AWS_REMOTE_COMMAND_GUARD_TTL_SECONDS, getS3Client } from "@/lib/aws";
import { getOAuthRelayDocumentName, getUploadBucketName } from "@/lib/env";
import { validateOAuthCallbackUrl } from "@/lib/oauth-callback";
import { createOAuthRelayPayload } from "@/lib/oauth-relay";
import { readJsonBody, requireSameOriginJson } from "@/lib/request-security";
import {
  RuntimeCommandStillRunningError,
  runDocumentCommand,
} from "@/lib/ssm-command";

export const runtime = "nodejs";

const requestSchema = z.object({ callbackUrl: z.unknown() }).strict();
const CLEANUP_ATTEMPTS = 3;

async function deleteOAuthStagingObject(bucket: string, key: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await getS3Client().send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function POST(request: NextRequest) {
  let stagedObject: { bucket: string; key: string } | undefined;
  let cleanupIsSafe = true;
  let leaseReleaseIsSafe = true;
  let admissionLease: OperationLease | undefined;

  try {
    requireSameOriginJson(request);
    const { subject, runtime: assignedRuntime } =
      await requireAuthorizedRuntime();
    const body = requestSchema.parse(await readJsonBody(request));
    const callback = validateOAuthCallbackUrl(body.callbackUrl);
    await enforceRateLimit(subject, "oauthRelay");
    admissionLease = await acquireOperationLease(
      subject,
      "oauth-relay",
      assignedRuntime.instanceId,
      AWS_REMOTE_COMMAND_GUARD_TTL_SECONDS,
    );
    const bucket = getUploadBucketName();
    const relayId = randomUUID();
    const key = `uploads/${subject}/${relayId}/oauth-callback.url`;
    const s3 = getS3Client();
    stagedObject = { bucket, key };

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createOAuthRelayPayload(callback.callbackUrl),
        ContentType: "application/octet-stream",
        CacheControl: "no-store",
      }),
    );

    await requireCurrentRuntimeAssignment(subject, assignedRuntime.instanceId);
    await runDocumentCommand(
      assignedRuntime.instanceId,
      getOAuthRelayDocumentName(),
      {
        UploadBucket: [bucket],
        UserSubject: [subject],
        RelayId: [relayId],
      },
      "Relay AgentFormation OAuth loopback callback",
    );
    return apiJsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof RuntimeCommandStillRunningError) {
      cleanupIsSafe = false;
      leaseReleaseIsSafe = false;
    }
    return apiErrorResponse(error, "oauth.loopback.failed");
  } finally {
    if (stagedObject && cleanupIsSafe) {
      try {
        await deleteOAuthStagingObject(stagedObject.bucket, stagedObject.key);
      } catch (error) {
        console.error("OAuth callback staging cleanup failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    if (leaseReleaseIsSafe) {
      try {
        await releaseOperationLease(admissionLease);
      } catch (error) {
        console.error("OAuth callback lease release failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }
}
