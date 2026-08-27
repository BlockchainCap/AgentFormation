import { createHash, randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ApiError } from "./api-error";
import { getDocumentClient } from "./aws";
import { getControlTableName } from "./env";

const ratePolicies = {
  environmentRead: { limit: 40, windowSeconds: 60 },
  environmentCreate: { limit: 4, windowSeconds: 60 * 60 },
  sessionStart: { limit: 20, windowSeconds: 60 },
  sessionResume: { limit: 40, windowSeconds: 60 },
  sessionTerminate: { limit: 40, windowSeconds: 60 },
  uploadCreate: { limit: 60, windowSeconds: 60 * 60 },
  uploadBytes: { limit: 2 * 1024 * 1024 * 1024, windowSeconds: 60 * 60 },
  uploadComplete: { limit: 60, windowSeconds: 60 * 60 },
  oauthRelay: { limit: 20, windowSeconds: 60 * 60 },
} as const;

export type RateOperation = keyof typeof ratePolicies;

function isConditionalFailure(error: unknown): error is Error {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

function resourceDigest(resource: string): string {
  return createHash("sha256").update(resource).digest("base64url").slice(0, 24);
}

export async function enforceRateLimit(
  subject: string,
  operation: RateOperation,
  weight = 1,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const policy = ratePolicies[operation];
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > policy.limit) {
    throw new ApiError(429, "Request limit exceeded; wait and try again");
  }

  const windowStart =
    nowSeconds - (nowSeconds % Math.max(1, policy.windowSeconds));
  try {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: getControlTableName(),
        Key: {
          controlKey: `rate#${operation}#${subject}#${windowStart}`,
        },
        UpdateExpression: "SET #expiresAt = :expiresAt ADD #usage :weight",
        ConditionExpression:
          "attribute_not_exists(#usage) OR #usage <= :remaining",
        ExpressionAttributeNames: {
          "#expiresAt": "expiresAt",
          "#usage": "usage",
        },
        ExpressionAttributeValues: {
          ":expiresAt": windowStart + policy.windowSeconds + 60,
          ":remaining": policy.limit - weight,
          ":weight": weight,
        },
      }),
    );
  } catch (error) {
    if (isConditionalFailure(error)) {
      throw new ApiError(429, "Request limit exceeded; wait and try again");
    }
    throw error;
  }
}

export interface OperationLease {
  controlKey: string;
  leaseId: string;
}

export async function acquireOperationLease(
  subject: string,
  operation: string,
  resource: string,
  ttlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<OperationLease> {
  const lease: OperationLease = {
    controlKey: `lease#${operation}#${subject}#${resourceDigest(resource)}`,
    leaseId: randomUUID(),
  };
  try {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getControlTableName(),
        Item: {
          ...lease,
          expiresAt: nowSeconds + ttlSeconds,
        },
        ConditionExpression:
          "attribute_not_exists(controlKey) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": nowSeconds },
      }),
    );
    return lease;
  } catch (error) {
    if (isConditionalFailure(error)) {
      throw new ApiError(
        429,
        "Another request is already in progress; wait and try again",
      );
    }
    throw error;
  }
}

export async function releaseOperationLease(
  lease: OperationLease | undefined,
): Promise<void> {
  if (!lease) return;
  try {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getControlTableName(),
        Key: { controlKey: lease.controlKey },
        ConditionExpression: "leaseId = :leaseId",
        ExpressionAttributeValues: { ":leaseId": lease.leaseId },
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) {
      console.error("admission.lease.cleanup.failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

export interface IdempotentAction {
  acquired: boolean;
  completed: boolean;
  lease?: OperationLease;
}

export async function beginIdempotentAction(
  subject: string,
  operation: string,
  resource: string,
  pendingTtlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<IdempotentAction> {
  const lease: OperationLease = {
    controlKey: `once#${operation}#${subject}#${resourceDigest(resource)}`,
    leaseId: randomUUID(),
  };
  try {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getControlTableName(),
        Item: {
          ...lease,
          actionState: "pending",
          expiresAt: nowSeconds + pendingTtlSeconds,
        },
        ConditionExpression:
          "attribute_not_exists(controlKey) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": nowSeconds },
      }),
    );
    return { acquired: true, completed: false, lease };
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    const existing = await getDocumentClient().send(
      new GetCommand({
        TableName: getControlTableName(),
        Key: { controlKey: lease.controlKey },
        ConsistentRead: true,
      }),
    );
    return {
      acquired: false,
      completed:
        existing.Item?.actionState === "completed" &&
        typeof existing.Item.expiresAt === "number" &&
        existing.Item.expiresAt >= nowSeconds,
    };
  }
}

export async function completeIdempotentAction(
  action: IdempotentAction,
  completedTtlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  if (!action.acquired || !action.lease) return;
  try {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: getControlTableName(),
        Key: { controlKey: action.lease.controlKey },
        UpdateExpression:
          "SET #actionState = :completed, #expiresAt = :expiresAt",
        ConditionExpression: "leaseId = :leaseId AND #actionState = :pending",
        ExpressionAttributeNames: {
          "#actionState": "actionState",
          "#expiresAt": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":completed": "completed",
          ":expiresAt": nowSeconds + completedTtlSeconds,
          ":leaseId": action.lease.leaseId,
          ":pending": "pending",
        },
      }),
    );
  } catch (error) {
    // The protected side effect has already succeeded. A missing, replaced, or
    // temporarily unavailable marker must not turn that success into a
    // client-visible failure. The pending marker expires on its short TTL, and
    // repeating the protected termination after that is safe.
    console.error("admission.completion.marker.failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function cancelIdempotentAction(
  action: IdempotentAction,
): Promise<void> {
  await releaseOperationLease(action.lease);
}
