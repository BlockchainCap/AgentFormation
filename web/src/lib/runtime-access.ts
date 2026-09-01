import { z } from "zod";

const runtimeRecordBaseSchema = z.object({
  userSub: z.string().uuid(),
  email: z.string().email(),
  runtimeStackName: z.string().min(1).max(128),
  provisioningStartedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
});

export const runtimeRecordSchema = z.discriminatedUnion("status", [
  runtimeRecordBaseSchema.extend({ status: z.literal("provisioning") }),
  runtimeRecordBaseSchema.extend({ status: z.literal("failed") }),
  runtimeRecordBaseSchema.extend({
    status: z.literal("active"),
    instanceId: z.string().regex(/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/),
  }),
  runtimeRecordBaseSchema.extend({
    status: z.literal("disabled"),
    instanceId: z
      .string()
      .regex(/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/)
      .optional(),
  }),
  z
    .object({
      userSub: z.string().uuid(),
      status: z.literal("purged"),
      updatedAt: z.string().datetime(),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
]);

export type RuntimeRecord = z.infer<typeof runtimeRecordSchema>;
export type ActiveRuntimeRecord = Extract<RuntimeRecord, { status: "active" }>;
type RevokedRuntimeRecord = Extract<
  RuntimeRecord,
  { status: "disabled" | "purged" }
>;

export function isActiveRuntime(
  record: RuntimeRecord | undefined,
): record is ActiveRuntimeRecord {
  return record?.status === "active";
}

export function isRuntimeAccessRevoked(
  record: RuntimeRecord | undefined,
): record is RevokedRuntimeRecord {
  return record?.status === "disabled" || record?.status === "purged";
}

export function canSubjectAccessRuntime(
  subject: string,
  record: RuntimeRecord | undefined,
): record is ActiveRuntimeRecord {
  return record?.userSub === subject && isActiveRuntime(record);
}
