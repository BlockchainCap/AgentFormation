import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ApiError } from "./api-error";
import { getDocumentClient } from "./aws";
import { getControlTableName } from "./env";

const UPLOAD_RESERVATION_SECONDS = 10 * 60;
const UPLOAD_CLAIM_SECONDS = 10 * 60;
const UPLOAD_CLAIM_RECORD_SECONDS = 15 * 60;
const COMPLETED_UPLOAD_RECORD_SECONDS = 60 * 60;

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

function uploadControlKey(subject: string, uploadId: string): string {
  return `upload#${subject}#${uploadId}`;
}

export interface UploadReservation {
  subject: string;
  uploadId: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  instanceId: string;
}

export interface UploadCompletionClaim {
  controlKey: string;
  claimId: string;
}

export async function registerUploadReservation(
  reservation: UploadReservation,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  try {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getControlTableName(),
        Item: {
          controlKey: uploadControlKey(
            reservation.subject,
            reservation.uploadId,
          ),
          ...reservation,
          status: "pending",
          expiresAt: nowSeconds + UPLOAD_RESERVATION_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(controlKey)",
      }),
    );
  } catch (error) {
    if (isConditionalFailure(error)) {
      throw new ApiError(409, "Upload could not be reserved; try again");
    }
    throw error;
  }
}

export async function claimUploadCompletion(
  reservation: UploadReservation,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<UploadCompletionClaim> {
  const claim: UploadCompletionClaim = {
    controlKey: uploadControlKey(reservation.subject, reservation.uploadId),
    claimId: randomUUID(),
  };
  try {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: getControlTableName(),
        Key: { controlKey: claim.controlKey },
        UpdateExpression:
          "SET #status = :completing, claimId = :claimId, claimExpiresAt = :claimExpiresAt, expiresAt = :expiresAt",
        ConditionExpression:
          "expiresAt >= :now AND (#status = :pending OR (#status = :completing AND claimExpiresAt < :now)) AND #subject = :subject AND uploadId = :uploadId AND objectKey = :objectKey AND filename = :filename AND mimeType = :mimeType AND fileSize = :fileSize AND instanceId = :instanceId",
        ExpressionAttributeNames: {
          "#status": "status",
          "#subject": "subject",
        },
        ExpressionAttributeValues: {
          ":claimExpiresAt": nowSeconds + UPLOAD_CLAIM_SECONDS,
          ":claimId": claim.claimId,
          ":completing": "completing",
          ":expiresAt": nowSeconds + UPLOAD_CLAIM_RECORD_SECONDS,
          ":fileSize": reservation.fileSize,
          ":filename": reservation.filename,
          ":instanceId": reservation.instanceId,
          ":mimeType": reservation.mimeType,
          ":now": nowSeconds,
          ":objectKey": reservation.objectKey,
          ":pending": "pending",
          ":subject": reservation.subject,
          ":uploadId": reservation.uploadId,
        },
      }),
    );
    return claim;
  } catch (error) {
    if (isConditionalFailure(error)) {
      throw new ApiError(409, "Upload is invalid, expired, or already handled");
    }
    throw error;
  }
}

export async function completeUploadClaim(
  claim: UploadCompletionClaim,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  await getDocumentClient().send(
    new UpdateCommand({
      TableName: getControlTableName(),
      Key: { controlKey: claim.controlKey },
      UpdateExpression:
        "SET #status = :completed, expiresAt = :expiresAt REMOVE claimId, claimExpiresAt",
      ConditionExpression: "#status = :completing AND claimId = :claimId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":claimId": claim.claimId,
        ":completed": "completed",
        ":completing": "completing",
        ":expiresAt": nowSeconds + COMPLETED_UPLOAD_RECORD_SECONDS,
      },
    }),
  );
}

export async function abandonUploadClaim(
  claim: UploadCompletionClaim | undefined,
): Promise<void> {
  if (!claim) return;
  try {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getControlTableName(),
        Key: { controlKey: claim.controlKey },
        ConditionExpression: "claimId = :claimId",
        ExpressionAttributeValues: { ":claimId": claim.claimId },
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) {
      console.error("upload.claim.cleanup.failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
