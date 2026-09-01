import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTerminateToken, verifyTerminateToken } from "./session-proof";

const SUBJECT = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_ID = "session-123";
const INSTANCE_ID = "i-0123456789abcdef0";
const NOW = 1_800_000_000;

describe("session control tokens", () => {
  beforeEach(() => {
    process.env.AWS_REGION = "us-east-1";
    process.env.AUTH_COGNITO_ID = "client";
    process.env.AUTH_COGNITO_SECRET = "secret";
    process.env.AUTH_COGNITO_IDENTITY_PROVIDER = "IdentityCenter";
    process.env.AUTH_COGNITO_ISSUER =
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example";
    process.env.AUTH_SECRET = "test-session-signing-secret-at-least-32-bytes";
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AUTH_COGNITO_ID;
    delete process.env.AUTH_COGNITO_SECRET;
    delete process.env.AUTH_COGNITO_IDENTITY_PROVIDER;
    delete process.env.AUTH_COGNITO_ISSUER;
    delete process.env.AUTH_SECRET;
  });

  it("binds a session to its subject, runtime, and expiry", () => {
    const token = createTerminateToken(SUBJECT, SESSION_ID, INSTANCE_ID, NOW);

    expect(
      verifyTerminateToken(SUBJECT, SESSION_ID, INSTANCE_ID, token, NOW),
    ).toBe(true);
    expect(
      verifyTerminateToken(
        SUBJECT,
        SESSION_ID,
        "i-fedcba98765432100",
        token,
        NOW,
      ),
    ).toBe(false);
    expect(
      verifyTerminateToken(
        "00000000-0000-4000-8000-000000000000",
        SESSION_ID,
        INSTANCE_ID,
        token,
        NOW,
      ),
    ).toBe(false);
    expect(
      verifyTerminateToken(
        SUBJECT,
        SESSION_ID,
        INSTANCE_ID,
        token,
        NOW + 14 * 60 * 60,
      ),
    ).toBe(false);
  });

  it("rejects a modified token", () => {
    const token = createTerminateToken(SUBJECT, SESSION_ID, INSTANCE_ID, NOW);
    for (const modified of [`${token}x`, `${token}=`, `${token}.extra`]) {
      expect(
        verifyTerminateToken(SUBJECT, SESSION_ID, INSTANCE_ID, modified, NOW),
      ).toBe(false);
    }
  });

  it("rejects a non-canonical spelling of a valid signature", () => {
    const token = createTerminateToken(SUBJECT, SESSION_ID, INSTANCE_ID, NOW);
    const [payload, signature] = token.split(".");
    const decodedSignature = Buffer.from(signature, "base64url");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternateLastCharacter = [...alphabet].find((character) => {
      if (character === signature.at(-1)) return false;
      return Buffer.from(
        `${signature.slice(0, -1)}${character}`,
        "base64url",
      ).equals(decodedSignature);
    });

    expect(alternateLastCharacter).toBeDefined();
    const alternateToken = `${payload}.${signature.slice(0, -1)}${alternateLastCharacter}`;
    expect(
      verifyTerminateToken(
        SUBJECT,
        SESSION_ID,
        INSTANCE_ID,
        alternateToken,
        NOW,
      ),
    ).toBe(false);
  });
});
