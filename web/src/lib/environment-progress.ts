import { z } from "zod";

export const provisioningStageSchema = z.enum([
  "confirming_access",
  "creating_access",
  "attaching_access",
  "starting_machine",
  "finishing",
]);

export type ProvisioningStage = z.infer<typeof provisioningStageSchema>;

export const provisioningProgressSchema = z.object({
  stage: provisioningStageSchema,
  startedAt: z.string().datetime(),
});

export type ProvisioningProgress = z.infer<typeof provisioningProgressSchema>;

export const environmentResponseSchema = z.object({
  status: z.enum([
    "not_created",
    "provisioning",
    "failed",
    "active",
    "disabled",
  ]),
  progress: provisioningProgressSchema.optional(),
});

export interface SafeStackEvent {
  logicalResourceId?: string;
  resourceStatus?: string;
}

export const provisioningSteps = [
  {
    id: "confirming_access",
    label: "Confirm company access",
    detail: "Check that your assigned company sign-in can create a runtime.",
    estimate: "About 3–5 minutes left",
    percent: 10,
  },
  {
    id: "creating_access",
    label: "Create private AWS access",
    detail: "Create the limited AWS permissions used only by your runtime.",
    estimate: "About 2–4 minutes left",
    percent: 25,
  },
  {
    id: "attaching_access",
    label: "Attach runtime access",
    detail: "Attach those permissions to your private coding machine.",
    estimate: "About 1–3 minutes left",
    percent: 50,
  },
  {
    id: "starting_machine",
    label: "Start coding machine",
    detail: "Start the private machine that keeps your workspace.",
    estimate: "About 30–90 seconds left",
    percent: 80,
  },
  {
    id: "finishing",
    label: "Open workspace",
    detail: "Save your assignment and open the terminal at /workspace.",
    estimate: "Usually less than 30 seconds left",
    percent: 95,
  },
] as const satisfies ReadonlyArray<{
  id: ProvisioningStage;
  label: string;
  detail: string;
  estimate: string;
  percent: number;
}>;

function latestResourceStatus(
  events: readonly SafeStackEvent[],
  logicalResourceId: string,
): string | undefined {
  return events.find((event) => event.logicalResourceId === logicalResourceId)
    ?.resourceStatus;
}

export function stageFromStackEvents(
  events: readonly SafeStackEvent[],
): ProvisioningStage {
  const machineStatus = latestResourceStatus(events, "RuntimeInstance");
  if (machineStatus === "CREATE_COMPLETE") return "finishing";
  if (machineStatus) return "starting_machine";

  const profileStatus = latestResourceStatus(events, "RuntimeInstanceProfile");
  if (profileStatus === "CREATE_COMPLETE") return "starting_machine";
  if (profileStatus) return "attaching_access";

  const roleStatus = latestResourceStatus(events, "RuntimeRole");
  if (roleStatus === "CREATE_COMPLETE") return "attaching_access";
  return "creating_access";
}

export function progressForStage(
  stage: ProvisioningStage,
  startedAt: string,
): ProvisioningProgress {
  return provisioningProgressSchema.parse({ stage, startedAt });
}
