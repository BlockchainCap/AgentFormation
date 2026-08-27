import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./content-security-policy";

describe("contentSecurityPolicy", () => {
  it("uses a per-request script nonce without unsafe inline scripts", () => {
    const policy = contentSecurityPolicy(
      "test-nonce",
      "us-east-1",
      "agentformation-uploads",
      false,
    );

    expect(policy).toContain(
      "script-src 'self' 'nonce-test-nonce' 'strict-dynamic'",
    );
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).toContain("wss://ssmmessages.us-east-1.amazonaws.com");
    expect(policy).toContain(
      "https://agentformation-uploads.s3.us-east-1.amazonaws.com",
    );
    expect(
      policy
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("connect-src ")),
    ).toBe(
      "connect-src 'self' wss://ssmmessages.us-east-1.amazonaws.com https://agentformation-uploads.s3.us-east-1.amazonaws.com https://agentformation-uploads.s3.amazonaws.com",
    );
    expect(policy).not.toMatch(/connect-src[^;]*\*/);
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("permits the development evaluator only in development", () => {
    const policy = contentSecurityPolicy(
      "test-nonce",
      "us-east-1",
      "agentformation-uploads",
      true,
    );

    expect(policy).toContain("'unsafe-eval'");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it("uses the AWS China URL suffix for China regions", () => {
    const policy = contentSecurityPolicy(
      "test-nonce",
      "cn-north-1",
      "agentformation-uploads",
      false,
    );

    expect(policy).toContain("wss://ssmmessages.cn-north-1.amazonaws.com.cn");
    expect(policy).toContain(
      "https://agentformation-uploads.s3.cn-north-1.amazonaws.com.cn",
    );
  });
});
