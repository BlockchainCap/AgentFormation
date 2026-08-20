import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse } from "@/lib/api-error";
import { requireAuthorizedRuntime } from "@/lib/authorization";
import { getS3Client } from "@/lib/aws";
import { getUploadBucketName } from "@/lib/env";
import { runShellCommand } from "@/lib/ssm-command";
import { shellQuote } from "@/lib/shell";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNED_URL_SECONDS = 5 * 60;

const createSchema = z.object({
  action: z.literal("create"),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});
const completeSchema = z.object({
  action: z.literal("complete"),
  key: z.string().min(1).max(1_024),
});
const requestSchema = z.discriminatedUnion("action", [
  createSchema,
  completeSchema,
]);

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

export async function POST(request: NextRequest) {
  try {
    const { subject, runtime: assignedRuntime } =
      await requireAuthorizedRuntime();
    const body = requestSchema.parse(await request.json());
    const bucket = getUploadBucketName();
    const s3 = getS3Client();

    if (body.action === "create") {
      const filename = safeFilename(body.filename);
      const key = `${uploadPrefix(subject)}${randomUUID()}-${filename}`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: body.contentType,
          ContentLength: body.size,
        }),
        { expiresIn: SIGNED_URL_SECONDS },
      );
      return NextResponse.json({ key, uploadUrl, filename });
    }

    if (!body.key.startsWith(uploadPrefix(subject))) {
      throw new ApiError(403, "Forbidden");
    }
    const object = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: body.key }),
    );
    if (!object.ContentLength || object.ContentLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(400, "Invalid upload size");
    }

    const filename = safeFilename(
      body.key.slice(uploadPrefix(subject).length + 37),
    );
    const destination = `/workspace/.uploads/${randomUUID()}-${filename}`;
    await runShellCommand(
      assignedRuntime.instanceId,
      [
        "install -d -m 700 -o agentformation -g agentformation /workspace/.uploads",
        `aws s3 cp ${shellQuote(`s3://${bucket}/${body.key}`)} ${shellQuote(destination)}`,
        `chown agentformation:agentformation ${shellQuote(destination)}`,
        `chmod 600 ${shellQuote(destination)}`,
      ],
      "Copy AgentFormation upload to assigned runtime",
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: body.key }));
    return NextResponse.json({ path: destination, filename });
  } catch (error) {
    return apiErrorResponse(error, "session.upload.failed");
  }
}
