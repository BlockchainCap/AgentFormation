import { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorResponse, apiJsonResponse } from "@/lib/api-error";
import { requireAuthenticatedIdentity } from "@/lib/authorization";
import { getProvisioningProgress } from "@/lib/provisioning-status";
import { startRuntimeProvisioning } from "@/lib/provisioning";
import { getRuntimeForSubject } from "@/lib/registry";
import { requireSameOriginJson } from "@/lib/request-security";

const requestSchema = z.object({}).strict();

export async function GET() {
  try {
    const { subject } = await requireAuthenticatedIdentity();
    const runtime = await getRuntimeForSubject(subject);
    const progress =
      runtime?.status === "provisioning"
        ? await getProvisioningProgress(runtime)
        : undefined;
    return apiJsonResponse({
      status: runtime?.status ?? "not_created",
      progress,
    });
  } catch (error) {
    return apiErrorResponse(error, "environment.read.failed");
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOriginJson(request);
    requestSchema.parse(await request.json());
    const { subject, email } = await requireAuthenticatedIdentity();
    await startRuntimeProvisioning(subject, email);
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
  }
}
