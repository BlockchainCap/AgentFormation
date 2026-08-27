import { describe, expect, it } from "vitest";
import { createOAuthRelayPayload } from "./oauth-relay";

describe("OAuth callback relay staging", () => {
  it("stores only the bounded canonical callback URL", () => {
    const callbackUrl =
      "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&path=one\\two";
    expect(createOAuthRelayPayload(callbackUrl)).toBe(callbackUrl);
  });

  it("rejects controls and oversized staging payloads", () => {
    expect(() =>
      createOAuthRelayPayload(
        "http://127.0.0.1:46189/callback?code=one\nupload-file=/etc/passwd",
      ),
    ).toThrow("unsafe control character");
    expect(() => createOAuthRelayPayload("x".repeat(4_097))).toThrow(
      "too long",
    );
  });
});
