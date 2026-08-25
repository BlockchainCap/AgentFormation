import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import { requireAuthorizedRuntime } from "@/lib/authorization";
import { getS3Client } from "@/lib/aws";
import { getUploadBucketName } from "@/lib/env";
import { validateOAuthCallbackUrl } from "@/lib/oauth-callback";
import {
  buildOAuthRelayCommands,
  serializeOAuthCallbackForCurl,
} from "@/lib/oauth-relay";
import { requireSameOriginJson } from "@/lib/request-security";
import { runShellCommand } from "@/lib/ssm-command";

export const runtime = "nodejs";

const requestSchema = z.object({ callbackUrl: z.unknown() }).strict();

export async function POST(request: NextRequest) {
  let stagedObject: { bucket: string; key: string } | undefined;

  try {
    requireSameOriginJson(request);
    const { subject, runtime: assignedRuntime } =
      await requireAuthorizedRuntime();
    const body = requestSchema.parse(await request.json());
    const callback = validateOAuthCallbackUrl(body.callbackUrl);
    const bucket = getUploadBucketName();
    const key = `uploads/${subject}/${randomUUID()}/oauth-callback.curl`;
    const s3 = getS3Client();
    stagedObject = { bucket, key };

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: serializeOAuthCallbackForCurl(callback.callbackUrl),
        ContentType: "application/octet-stream",
        CacheControl: "no-store",
      }),
    );

    await runShellCommand(
      assignedRuntime.instanceId,
      buildOAuthRelayCommands(bucket, key),
      "Relay AgentFormation OAuth loopback callback",
    );
    return apiJsonResponse({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, "oauth.loopback.failed");
  } finally {
    if (stagedObject) {
      try {
        await getS3Client().send(
          new DeleteObjectCommand({
            Bucket: stagedObject.bucket,
            Key: stagedObject.key,
          }),
        );
      } catch (error) {
        console.error("OAuth callback staging cleanup failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }
}
