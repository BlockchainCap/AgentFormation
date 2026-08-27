import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRecord } from "./runtime-access";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./aws", () => ({
  getCloudFormationClient: () => ({ send }),
}));

import { getProvisioningStatus } from "./provisioning-status";

const runtime = {
  userSub: "00000000-0000-4000-8000-000000000000",
  email: "person@example.com",
  runtimeStackName: "agentformation-runtime-0000000000004000",
  status: "provisioning",
  provisioningStartedAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:00:00.000Z",
} satisfies Extract<RuntimeRecord, { status: "provisioning" }>;

describe("current provisioning status", () => {
  beforeEach(() => send.mockReset());

  it("allows a short gap before CloudFormation creates the stack", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("Stack does not exist"), {
        name: "ValidationError",
      }),
    );

    await expect(
      getProvisioningStatus(runtime, new Date("2026-08-27T12:01:00.000Z")),
    ).resolves.toMatchObject({
      status: "provisioning",
      progress: { stage: "creating_access" },
    });
  });

  it("keeps a missing stack bounded by the overall stale deadline", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("Stack does not exist"), {
        name: "ValidationError",
      }),
    );

    await expect(
      getProvisioningStatus(runtime, new Date("2026-08-27T13:39:00.000Z")),
    ).resolves.toMatchObject({
      status: "provisioning",
      progress: { stage: "creating_access" },
    });
  });

  it("does not hide unrelated CloudFormation validation errors", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("Invalid stack identifier"), {
        name: "ValidationError",
      }),
    );

    await expect(
      getProvisioningStatus(runtime, new Date("2026-08-27T12:01:00.000Z")),
    ).rejects.toThrow("Invalid stack identifier");
  });

  it("stops presenting a stale provisioning record as still running", async () => {
    await expect(
      getProvisioningStatus(runtime, new Date("2026-08-27T13:41:00.000Z")),
    ).resolves.toEqual({ status: "failed" });
    expect(send).not.toHaveBeenCalled();
  });
});
