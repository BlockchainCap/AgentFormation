import { describe, expect, it } from "vitest";
import { canSubjectAccessRuntime, runtimeRecordSchema } from "./runtime-access";

const activeRuntime = {
  userSub: "user-a",
  email: "person@example.com",
  instanceId: "i-0123456789abcdef0",
  runtimeStackName: "agentformation-runtime-123",
  status: "active" as const,
  updatedAt: "2026-08-19T12:00:00Z",
};

describe("runtime access", () => {
  it("allows only the subject assigned to an active runtime", () => {
    expect(canSubjectAccessRuntime("user-a", activeRuntime)).toBe(true);
    expect(canSubjectAccessRuntime("user-b", activeRuntime)).toBe(false);
    expect(
      canSubjectAccessRuntime("user-a", {
        ...activeRuntime,
        status: "disabled",
      }),
    ).toBe(false);
  });

  it("rejects malformed registry records", () => {
    expect(
      runtimeRecordSchema.safeParse({
        ...activeRuntime,
        instanceId: "not-an-instance",
      }).success,
    ).toBe(false);
  });

  it("accepts provisioning records without exposing an instance", () => {
    const result = runtimeRecordSchema.safeParse({
      userSub: "user-a",
      email: "person@example.com",
      runtimeStackName: "agentformation-runtime-123",
      status: "provisioning",
      updatedAt: "2026-08-19T12:00:00Z",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect("instanceId" in result.data).toBe(false);
      expect(canSubjectAccessRuntime("user-a", result.data)).toBe(false);
    }
  });
});
