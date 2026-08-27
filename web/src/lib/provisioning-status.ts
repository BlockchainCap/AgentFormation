import { DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { getCloudFormationClient } from "./aws";
import {
  progressForStage,
  stageFromStackEvents,
  type ProvisioningProgress,
} from "./environment-progress";
import { PROVISIONING_STALE_AFTER_MS } from "./provisioning";
import type { RuntimeRecord } from "./runtime-access";

type ProvisioningRuntime = Extract<RuntimeRecord, { status: "provisioning" }>;
type CurrentProvisioningStatus =
  | { status: "provisioning"; progress: ProvisioningProgress }
  | { status: "failed" };

function provisioningAgeMs(runtime: ProvisioningRuntime, now: Date): number {
  const startedAt = runtime.provisioningStartedAt ?? runtime.updatedAt;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp)
    ? Math.max(0, now.getTime() - timestamp)
    : Number.POSITIVE_INFINITY;
}

export async function getProvisioningStatus(
  runtime: ProvisioningRuntime,
  now = new Date(),
): Promise<CurrentProvisioningStatus> {
  const startedAt = runtime.provisioningStartedAt ?? runtime.updatedAt;
  const ageMs = provisioningAgeMs(runtime, now);

  if (ageMs >= PROVISIONING_STALE_AFTER_MS) {
    return { status: "failed" };
  }

  try {
    const response = await getCloudFormationClient().send(
      new DescribeStackEventsCommand({ StackName: runtime.runtimeStackName }),
    );
    const safeEvents = (response.StackEvents ?? []).map((event) => ({
      logicalResourceId: event.LogicalResourceId,
      resourceStatus: event.ResourceStatus,
    }));
    return {
      status: "provisioning",
      progress: progressForStage(stageFromStackEvents(safeEvents), startedAt),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ValidationError" &&
      error.message.includes("does not exist")
    ) {
      return {
        status: "provisioning",
        progress: progressForStage("creating_access", startedAt),
      };
    }
    throw error;
  }
}
