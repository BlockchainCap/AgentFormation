import { z } from "zod";

export const runtimeRecordSchema = z.object({
  userSub: z.string().min(1),
  email: z.string().email(),
  instanceId: z.string().regex(/^i-[0-9a-f]+$/),
  runtimeStackName: z.string().min(1).max(128),
  status: z.enum(["active", "disabled"]),
  updatedAt: z.string().datetime(),
});

export type RuntimeRecord = z.infer<typeof runtimeRecordSchema>;

export function isActiveRuntime(
  record: RuntimeRecord | undefined,
): record is RuntimeRecord & { status: "active" } {
  return record?.status === "active";
}

export function canSubjectAccessRuntime(
  subject: string,
  record: RuntimeRecord | undefined,
): record is RuntimeRecord & { status: "active" } {
  return record?.userSub === subject && isActiveRuntime(record);
}
