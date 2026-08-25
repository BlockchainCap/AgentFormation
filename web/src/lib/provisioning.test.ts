import { describe, expect, it } from "vitest";
import { getProvisioningInput } from "./provisioning";

const SUBJECT = "00000000-0000-4000-8000-000000000000";

describe("runtime provisioning", () => {
  it("accepts a federated subject and normalizes its email", () => {
    expect(getProvisioningInput(SUBJECT, "Person@Example.com")).toEqual({
      subject: SUBJECT,
      email: "person@example.com",
    });
  });

  it("rejects input that is not a valid federated profile", () => {
    expect(() =>
      getProvisioningInput("not-a-subject", "not-an-email"),
    ).toThrow();
  });
});
