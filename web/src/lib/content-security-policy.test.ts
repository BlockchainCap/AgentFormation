import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./content-security-policy";

describe("contentSecurityPolicy", () => {
  it("uses a per-request script nonce without unsafe inline scripts", () => {
    const policy = contentSecurityPolicy("test-nonce", "us-east-1", false);

    expect(policy).toContain(
      "script-src 'self' 'nonce-test-nonce' 'strict-dynamic'",
    );
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).toContain("wss://ssmmessages.us-east-1.amazonaws.com");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("permits the development evaluator only in development", () => {
    const policy = contentSecurityPolicy("test-nonce", "us-east-1", true);

    expect(policy).toContain("'unsafe-eval'");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});
