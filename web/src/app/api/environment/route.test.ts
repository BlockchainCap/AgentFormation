import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireOperationLease: vi.fn(),
  enforceRateLimit: vi.fn(),
  getProvisioningStatus: vi.fn(),
  getRuntimeForSubject: vi.fn(),
  readJsonBody: vi.fn(),
  releaseOperationLease: vi.fn(),
  requireAuthenticatedIdentity: vi.fn(),
  requireSameOriginJson: vi.fn(),
  startRuntimeProvisioning: vi.fn(),
}));

vi.mock("@/lib/admission-control", () => ({
  acquireOperationLease: mocks.acquireOperationLease,
  enforceRateLimit: mocks.enforceRateLimit,
  releaseOperationLease: mocks.releaseOperationLease,
}));
vi.mock("@/lib/authorization", () => ({
  requireAuthenticatedIdentity: mocks.requireAuthenticatedIdentity,
}));
vi.mock("@/lib/provisioning-status", () => ({
  getProvisioningStatus: mocks.getProvisioningStatus,
}));
vi.mock("@/lib/provisioning", () => ({
  startRuntimeProvisioning: mocks.startRuntimeProvisioning,
}));
vi.mock("@/lib/registry", () => ({
  getRuntimeForSubject: mocks.getRuntimeForSubject,
}));
vi.mock("@/lib/request-security", () => ({
  readJsonBody: mocks.readJsonBody,
  requireSameOriginJson: mocks.requireSameOriginJson,
}));

import { GET, POST } from "./route";

const subject = "00000000-0000-4000-8000-000000000000";
const baseRuntime = {
  userSub: subject,
  email: "person@example.com",
  runtimeStackName: "agentformation-runtime-0000000000004000",
  updatedAt: "2026-08-27T12:00:00.000Z",
};

function request() {
  return new NextRequest("https://agentformation.example/api/environment", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
}

describe("environment creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedIdentity.mockResolvedValue({
      subject,
      email: "person@example.com",
    });
    mocks.readJsonBody.mockResolvedValue({});
    mocks.acquireOperationLease.mockResolvedValue({
      controlKey: "lease-key",
      leaseId: "lease-id",
    });
    mocks.startRuntimeProvisioning.mockResolvedValue(undefined);
  });

  it.each([
    {
      label: "disabled",
      runtime: {
        ...baseRuntime,
        status: "disabled",
        instanceId: "i-0123456789abcdef0",
      },
    },
    {
      label: "purged",
      runtime: {
        userSub: subject,
        status: "purged",
        updatedAt: "2026-08-27T12:00:00.000Z",
        expiresAt: 1_777_000_000,
      },
    },
  ])(
    "denies an unexpired session after access is $label",
    async ({ runtime }) => {
      mocks.getRuntimeForSubject.mockResolvedValue(runtime);

      const response = await POST(request());

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Runtime access has been revoked",
      });
      expect(mocks.acquireOperationLease).not.toHaveBeenCalled();
      expect(mocks.startRuntimeProvisioning).not.toHaveBeenCalled();
    },
  );

  it("reports a purge tombstone as disabled without exposing its internal status", async () => {
    mocks.getRuntimeForSubject.mockResolvedValue({
      userSub: subject,
      status: "purged",
      updatedAt: "2026-08-27T12:00:00.000Z",
      expiresAt: 1_777_000_000,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "disabled" });
    expect(mocks.getProvisioningStatus).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "active",
      runtime: {
        ...baseRuntime,
        status: "active",
        instanceId: "i-0123456789abcdef0",
      },
      error: "Environment already exists",
    },
    {
      label: "provisioning",
      runtime: {
        ...baseRuntime,
        status: "provisioning",
        provisioningStartedAt: "2026-08-27T12:00:00.000Z",
      },
      error: "Environment creation is already in progress",
    },
  ])("does not start over an $label runtime", async ({ runtime, error }) => {
    mocks.getRuntimeForSubject.mockResolvedValue(runtime);
    mocks.getProvisioningStatus.mockResolvedValue({
      status: "provisioning",
      progress: {
        stage: "creating_access",
        percent: 10,
        label: "Creating access",
        startedAt: "2026-08-27T12:00:00.000Z",
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.startRuntimeProvisioning).not.toHaveBeenCalled();
  });

  it("allows a failed or stale provisioning record to be retried", async () => {
    mocks.getRuntimeForSubject.mockResolvedValue({
      ...baseRuntime,
      status: "provisioning",
      provisioningStartedAt: "2026-08-27T12:00:00.000Z",
    });
    mocks.getProvisioningStatus.mockResolvedValue({ status: "failed" });

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(mocks.startRuntimeProvisioning).toHaveBeenCalledWith(
      subject,
      "person@example.com",
    );
    expect(mocks.acquireOperationLease).toHaveBeenCalledWith(
      subject,
      "environment-create",
      "runtime",
      120,
    );
    expect(mocks.releaseOperationLease).toHaveBeenCalledWith(undefined);
  });

  it("releases the lease when starting Step Functions fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const lease = { controlKey: "lease-key", leaseId: "lease-id" };
      mocks.getRuntimeForSubject.mockResolvedValue(undefined);
      mocks.acquireOperationLease.mockResolvedValue(lease);
      mocks.startRuntimeProvisioning.mockRejectedValue(new Error("AWS failed"));

      const response = await POST(request());

      expect(response.status).toBe(500);
      expect(mocks.releaseOperationLease).toHaveBeenCalledWith(lease);
      expect(errorLog).toHaveBeenCalledWith("environment.provision.failed", {
        errorType: "Error",
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
