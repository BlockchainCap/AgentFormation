import { randomUUID } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
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
import { AWS_REMOTE_COMMAND_GUARD_TTL_SECONDS, getS3Client } from "@/lib/aws";
import { getUploadBucketName, getUploadDeliveryDocumentName } from "@/lib/env";
import { readJsonBody, requireSameOriginJson } from "@/lib/request-security";
import {
  RuntimeCommandStillRunningError,
  runDocumentCommand,
} from "@/lib/ssm-command";
import {
  abandonUploadClaim,
  claimUploadCompletion,
  completeUploadClaim,
  registerUploadReservation,
  type UploadCompletionClaim,
} from "@/lib/upload-admission";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNED_URL_SECONDS = 5 * 60;
const CLEANUP_ATTEMPTS = 3;

const createSchema = z
  .object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    fileSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  })
  .strict();
const completeSchema = z
  .object({
    key: z.string().min(1).max(1_024),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    fileSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    tmuxSession: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  })
  .strict();

function safeFilename(value: string): string {
  const basename = value.split(/[\\/]/).at(-1)?.trim() ?? "";
  return (
    basename
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 120) || "upload"
  );
}

function uploadPrefix(subject: string): string {
  return `uploads/${subject}/`;
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function safeMimeType(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new ApiError(400, "Invalid file type");
  }
  return value.trim() || "application/octet-stream";
}

async function deleteStagedObjects(
  bucket: string,
  keys: readonly string[],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const response = await getS3Client().send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Quiet: true,
            Objects: keys.map((Key) => ({ Key })),
          },
        }),
      );
      if ((response.Errors?.length ?? 0) > 0) {
        throw new Error("S3 rejected staged-object cleanup");
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function POST(request: NextRequest) {
  try {
    requireSameOriginJson(request);
    const { subject, runtime } = await requireAuthorizedRuntime();
    const body = createSchema.parse(await readJsonBody(request));
    await requireCurrentRuntimeAssignment(subject, runtime.instanceId);
    await enforceRateLimit(subject, "uploadCreate");
    await enforceRateLimit(subject, "uploadBytes", body.fileSize);
    const bucket = getUploadBucketName();
    const s3 = getS3Client();
    const filename = safeFilename(body.filename);
    const mimeType = safeMimeType(body.mimeType);
    const uploadId = randomUUID();
    const key = `${uploadPrefix(subject)}${uploadId}/${filename}`;
    const upload = await createPresignedPost(s3, {
      Bucket: bucket,
      Key: key,
      Expires: SIGNED_URL_SECONDS,
      Fields: {
        key,
        "Content-Type": mimeType,
        success_action_status: "204",
      },
      Conditions: [
        ["content-length-range", body.fileSize, body.fileSize],
        ["eq", "$key", key],
        ["eq", "$Content-Type", mimeType],
        ["eq", "$success_action_status", "204"],
      ],
    });
    await registerUploadReservation({
      subject,
      uploadId,
      objectKey: key,
      filename,
      mimeType,
      fileSize: body.fileSize,
      instanceId: runtime.instanceId,
    });
    return apiJsonResponse({
      key,
      filename,
      mimeType,
      fileSize: body.fileSize,
      uploadUrl: upload.url,
      method: "POST",
      formFields: upload.fields,
    });
  } catch (error) {
    return apiErrorResponse(error, "session.upload.create.failed");
  }
}

export async function PATCH(request: NextRequest) {
  let cleanup: { bucket: string; keys: string[] } | undefined;
  let cleanupIsSafe = true;
  let completionClaim: UploadCompletionClaim | undefined;
  let completionRecorded = false;
  let admissionLease: OperationLease | undefined;

  try {
    requireSameOriginJson(request);
    const { subject, runtime: assignedRuntime } =
      await requireAuthorizedRuntime();
    const body = completeSchema.parse(await readJsonBody(request));
    const prefix = uploadPrefix(subject);
    if (!body.key.startsWith(prefix)) {
      throw new ApiError(403, "Forbidden");
    }

    const filename = safeFilename(body.filename);
    const mimeType = safeMimeType(body.mimeType);
    const suffix = body.key.slice(prefix.length);
    const [uploadId, keyFilename, ...extraParts] = suffix.split("/");
    if (
      extraParts.length > 0 ||
      !z.string().uuid().safeParse(uploadId).success ||
      keyFilename !== filename
    ) {
      throw new ApiError(400, "Invalid upload key");
    }

    const bucket = getUploadBucketName();
    const sealedKey = `${prefix}${uploadId}/sealed/${filename}`;
    await requireCurrentRuntimeAssignment(subject, assignedRuntime.instanceId);
    await enforceRateLimit(subject, "uploadComplete");
    admissionLease = await acquireOperationLease(
      subject,
      "upload-complete",
      assignedRuntime.instanceId,
      AWS_REMOTE_COMMAND_GUARD_TTL_SECONDS,
    );
    completionClaim = await claimUploadCompletion({
      subject,
      uploadId,
      objectKey: body.key,
      filename,
      mimeType,
      fileSize: body.fileSize,
      instanceId: assignedRuntime.instanceId,
    });
    cleanup = { bucket, keys: [body.key, sealedKey] };
    const s3 = getS3Client();
    const object = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: body.key }),
    );
    if (
      object.ContentLength !== body.fileSize ||
      object.ContentLength > MAX_UPLOAD_BYTES ||
      object.ContentType !== mimeType ||
      !object.ETag
    ) {
      throw new ApiError(400, "Uploaded file does not match");
    }

    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: sealedKey,
        CopySource: copySource(bucket, body.key),
        CopySourceIfMatch: object.ETag,
        MetadataDirective: "COPY",
      }),
    );
    const sealedObject = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: sealedKey }),
    );
    if (
      sealedObject.ContentLength !== body.fileSize ||
      sealedObject.ContentType !== mimeType
    ) {
      throw new ApiError(502, "Uploaded file could not be sealed");
    }

    const destination = `/workspace/.uploads/${uploadId}/${filename}`;
    await requireCurrentRuntimeAssignment(subject, assignedRuntime.instanceId);
    await runDocumentCommand(
      assignedRuntime.instanceId,
      getUploadDeliveryDocumentName(),
      {
        UploadBucket: [bucket],
        UserSubject: [subject],
        UploadId: [uploadId],
        Filename: [filename],
        TmuxSession: [body.tmuxSession],
        FileSize: [String(body.fileSize)],
      },
      "Copy AgentFormation upload to assigned runtime",
    );
    try {
      await completeUploadClaim(completionClaim);
    } catch (error) {
      // Delivery succeeded, so retain the exact sealed input and claim for a
      // safe retry instead of deleting the only recoverable copy.
      cleanupIsSafe = false;
      throw error;
    }
    completionRecorded = true;
    return apiJsonResponse({
      path: destination,
      filename,
      mimeType,
      fileSize: body.fileSize,
    });
  } catch (error) {
    if (error instanceof RuntimeCommandStillRunningError) {
      cleanupIsSafe = false;
    }
    return apiErrorResponse(error, "session.upload.complete.failed");
  } finally {
    if (cleanup && cleanupIsSafe) {
      try {
        await deleteStagedObjects(cleanup.bucket, cleanup.keys);
      } catch (error) {
        console.error("session.upload.cleanup.failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    if (completionClaim && !completionRecorded && cleanupIsSafe) {
      await abandonUploadClaim(completionClaim);
    }
    await releaseOperationLease(admissionLease);
  }
}
