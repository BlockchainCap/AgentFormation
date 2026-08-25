import { DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { getCloudFormationClient } from "./aws";
import {
  progressForStage,
  stageFromStackEvents,
  type ProvisioningProgress,
} from "./environment-progress";
import type { RuntimeRecord } from "./runtime-access";

type ProvisioningRuntime = Extract<RuntimeRecord, { status: "provisioning" }>;

export async function getProvisioningProgress(
  runtime: ProvisioningRuntime,
): Promise<ProvisioningProgress> {
  const startedAt = runtime.provisioningStartedAt ?? runtime.updatedAt;

  try {
    const response = await getCloudFormationClient().send(
      new DescribeStackEventsCommand({ StackName: runtime.runtimeStackName }),
    );
    const safeEvents = (response.StackEvents ?? []).map((event) => ({
      logicalResourceId: event.LogicalResourceId,
      resourceStatus: event.ResourceStatus,
    }));
    return progressForStage(stageFromStackEvents(safeEvents), startedAt);
  } catch (error) {
    if (error instanceof Error && error.name === "ValidationError") {
      return progressForStage("creating_access", startedAt);
    }
    throw error;
  }
}
