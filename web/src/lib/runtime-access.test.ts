import { describe, expect, it } from "vitest";
import {
  canSubjectAccessRuntime,
  isRuntimeAccessRevoked,
  runtimeRecordSchema,
} from "./runtime-access";

const activeRuntime = {
  userSub: "11111111-1111-4111-8111-111111111111",
  email: "person@example.com",
  instanceId: "i-0123456789abcdef0",
  runtimeStackName: "agentformation-runtime-123",
  status: "active" as const,
  updatedAt: "2026-08-19T12:00:00Z",
};

describe("runtime access", () => {
  it("allows only the subject assigned to an active runtime", () => {
    expect(
      canSubjectAccessRuntime(
        "11111111-1111-4111-8111-111111111111",
        activeRuntime,
      ),
    ).toBe(true);
    expect(
      canSubjectAccessRuntime(
        "22222222-2222-4222-8222-222222222222",
        activeRuntime,
      ),
    ).toBe(false);
    expect(
      canSubjectAccessRuntime("11111111-1111-4111-8111-111111111111", {
        ...activeRuntime,
        status: "disabled",
      }),
    ).toBe(false);
  });

  it("rejects malformed registry records", () => {
    for (const instanceId of [
      "not-an-instance",
      "i-0123456",
      "i-0123456789abcdef01",
    ]) {
      expect(
        runtimeRecordSchema.safeParse({
          ...activeRuntime,
          instanceId,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts both AWS instance ID lengths", () => {
    for (const instanceId of ["i-01234567", "i-0123456789abcdef0"]) {
      expect(
        runtimeRecordSchema.safeParse({ ...activeRuntime, instanceId }).success,
      ).toBe(true);
    }
  });

  it("accepts provisioning records without exposing an instance", () => {
    const result = runtimeRecordSchema.safeParse({
      userSub: "11111111-1111-4111-8111-111111111111",
      email: "person@example.com",
      runtimeStackName: "agentformation-runtime-123",
      status: "provisioning",
      updatedAt: "2026-08-19T12:00:00Z",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect("instanceId" in result.data).toBe(false);
      expect(
        canSubjectAccessRuntime(
          "11111111-1111-4111-8111-111111111111",
          result.data,
        ),
      ).toBe(false);
    }
  });

  it("accepts a disabled marker before any instance exists", () => {
    const result = runtimeRecordSchema.safeParse({
      userSub: "11111111-1111-4111-8111-111111111111",
      email: "person@example.com",
      runtimeStackName: "agentformation-runtime-123",
      status: "disabled",
      updatedAt: "2026-08-19T12:00:00Z",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        canSubjectAccessRuntime(
          "11111111-1111-4111-8111-111111111111",
          result.data,
        ),
      ).toBe(false);
    }
  });

  it("accepts a minimal purged tombstone and keeps it revoked", () => {
    const result = runtimeRecordSchema.safeParse({
      userSub: "11111111-1111-4111-8111-111111111111",
      status: "purged",
      updatedAt: "2026-08-28T12:00:00Z",
      expiresAt: 1_774_704_000,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(isRuntimeAccessRevoked(result.data)).toBe(true);
      expect(
        canSubjectAccessRuntime(
          "11111111-1111-4111-8111-111111111111",
          result.data,
        ),
      ).toBe(false);
      expect("email" in result.data).toBe(false);
      expect("runtimeStackName" in result.data).toBe(false);
    }
  });
});
