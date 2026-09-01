import { NextRequest } from "next/server";
import { z } from "zod";
import {
  acquireOperationLease,
  enforceRateLimit,
  releaseOperationLease,
  type OperationLease,
} from "@/lib/admission-control";
import { ApiError, apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import { requireAuthenticatedIdentity } from "@/lib/authorization";
import { AWS_MUTATION_GUARD_TTL_SECONDS } from "@/lib/aws";
import { getProvisioningStatus } from "@/lib/provisioning-status";
import { startRuntimeProvisioning } from "@/lib/provisioning";
import { getRuntimeForSubject } from "@/lib/registry";
import { readJsonBody, requireSameOriginJson } from "@/lib/request-security";
import { isRuntimeAccessRevoked } from "@/lib/runtime-access";

const requestSchema = z.object({}).strict();

async function requireProvisionableRuntime(subject: string): Promise<void> {
  const runtime = await getRuntimeForSubject(subject);
  if (!runtime || runtime.status === "failed") return;
  if (isRuntimeAccessRevoked(runtime)) {
    throw new ApiError(403, "Runtime access has been revoked");
  }
  if (runtime.status === "active") {
    throw new ApiError(409, "Environment already exists");
  }
  const current = await getProvisioningStatus(runtime);
  if (current.status === "provisioning") {
    throw new ApiError(409, "Environment creation is already in progress");
  }
}

export async function GET() {
  try {
    const { subject } = await requireAuthenticatedIdentity();
    await enforceRateLimit(subject, "environmentRead");
    const runtime = await getRuntimeForSubject(subject);
    const provisioning =
      runtime?.status === "provisioning"
        ? await getProvisioningStatus(runtime)
        : undefined;
    return apiJsonResponse({
      status:
        provisioning?.status ??
        (runtime?.status === "purged" ? "disabled" : runtime?.status) ??
        "not_created",
      progress:
        provisioning?.status === "provisioning"
          ? provisioning.progress
          : undefined,
    });
  } catch (error) {
    return apiErrorResponse(error, "environment.read.failed");
  }
}

export async function POST(request: NextRequest) {
  let lease: OperationLease | undefined;
  try {
    requireSameOriginJson(request);
    const { subject, email } = await requireAuthenticatedIdentity();
    requestSchema.parse(await readJsonBody(request));
    await enforceRateLimit(subject, "environmentCreate");
    await requireProvisionableRuntime(subject);
    lease = await acquireOperationLease(
      subject,
      "environment-create",
      "runtime",
      AWS_MUTATION_GUARD_TTL_SECONDS,
    );
    await startRuntimeProvisioning(subject, email);
    // Keep the short lease until its DynamoDB expiry so another web request
    // cannot slip into the gap before Step Functions reserves the registry.
    // The state machine's conditional registry write remains the durable lock.
    lease = undefined;
    return apiJsonResponse(
      {
        status: "provisioning",
        progress: {
          stage: "confirming_access",
          startedAt: new Date().toISOString(),
        },
      },
      { status: 202 },
    );
  } catch (error) {
    return apiErrorResponse(error, "environment.provision.failed");
  } finally {
    await releaseOperationLease(lease);
  }
}
