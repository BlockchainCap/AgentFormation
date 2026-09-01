import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./aws", () => ({
  getDocumentClient: () => ({ send }),
}));

import { getRuntimeForSubject } from "./registry";

const requestedSubject = "11111111-1111-4111-8111-111111111111";

describe("runtime registry", () => {
  beforeEach(() => {
    send.mockReset();
    vi.stubEnv("USER_REGISTRY_TABLE", "agentformation-users");
  });

  it("rejects a record that is not bound to the requested subject", async () => {
    send.mockResolvedValue({
      Item: {
        userSub: "22222222-2222-4222-8222-222222222222",
        email: "person@example.com",
        instanceId: "i-0123456789abcdef0",
        runtimeStackName: "agentformation-runtime-other",
        status: "active",
        updatedAt: "2026-08-19T12:00:00Z",
      },
    });

    await expect(getRuntimeForSubject(requestedSubject)).rejects.toThrow(
      "User registry record has an invalid shape",
    );
  });
});
