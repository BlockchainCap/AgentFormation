import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import { requireAuthorizedRuntime } from "@/lib/authorization";
import { getS3Client } from "@/lib/aws";
import { getUploadBucketName } from "@/lib/env";
import { requireSameOriginJson } from "@/lib/request-security";
import { runShellCommand } from "@/lib/ssm-command";
import { shellQuote } from "@/lib/shell";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNED_URL_SECONDS = 5 * 60;

const createSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});
const completeSchema = z.object({
  key: z.string().min(1).max(1_024),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  tmuxSession: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
});

function safeFilename(value: string): string {
  const basename = value.split(/[\\/]/).at(-1)?.trim() ?? "";
  return (
    basename
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "upload"
  );
}

function uploadPrefix(subject: string): string {
  return `uploads/${subject}/`;
}

function safeMimeType(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new ApiError(400, "Invalid file type");
  }
  return value.trim() || "application/octet-stream";
}

export async function POST(request: NextRequest) {
  try {
    requireSameOriginJson(request);
    const { subject } = await requireAuthorizedRuntime();
    const body = createSchema.parse(await request.json());
    const bucket = getUploadBucketName();
    const s3 = getS3Client();
    const filename = safeFilename(body.filename);
    const mimeType = safeMimeType(body.mimeType);
    const key = `${uploadPrefix(subject)}${randomUUID()}/${filename}`;
    const requiredHeaders = { "Content-Type": mimeType };
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: mimeType,
        ContentLength: body.fileSize,
      }),
      { expiresIn: SIGNED_URL_SECONDS },
    );
    return apiJsonResponse({
      key,
      filename,
      mimeType,
      fileSize: body.fileSize,
      uploadUrl,
      method: "PUT",
      requiredHeaders,
    });
  } catch (error) {
    return apiErrorResponse(error, "session.upload.create.failed");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    requireSameOriginJson(request);
    const { subject, runtime: assignedRuntime } =
      await requireAuthorizedRuntime();
    const body = completeSchema.parse(await request.json());
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
    const s3 = getS3Client();
    const object = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: body.key }),
    );
    if (
      object.ContentLength !== body.fileSize ||
      object.ContentLength > MAX_UPLOAD_BYTES
    ) {
      throw new ApiError(400, "Uploaded file size does not match");
    }

    const destinationDirectory = `/workspace/.uploads/${uploadId}`;
    const destination = `${destinationDirectory}/${filename}`;
    await runShellCommand(
      assignedRuntime.instanceId,
      [
        `tmux has-session -t ${shellQuote(body.tmuxSession)}`,
        `install -d -m 700 -o agentformation -g agentformation ${shellQuote(destinationDirectory)}`,
        `aws s3 cp ${shellQuote(`s3://${bucket}/${body.key}`)} ${shellQuote(destination)}`,
        `chown agentformation:agentformation ${shellQuote(destination)}`,
        `chmod 600 ${shellQuote(destination)}`,
      ],
      "Copy AgentFormation upload to assigned runtime",
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: body.key }));
    return apiJsonResponse({
      path: destination,
      filename,
      mimeType,
      fileSize: body.fileSize,
    });
  } catch (error) {
    return apiErrorResponse(error, "session.upload.complete.failed");
  }
}
