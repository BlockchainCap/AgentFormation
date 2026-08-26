import { describe, expect, it } from "vitest";
import { ApiError } from "./api-error";
import { validateOAuthCallbackUrl } from "./oauth-callback";

describe("validateOAuthCallbackUrl", () => {
  it("normalizes an allowed localhost callback", () => {
    expect(
      validateOAuthCallbackUrl(
        "http://localhost:46158/callback?state=abc&code=secret",
      ),
    ).toEqual({
      callbackUrl: "http://127.0.0.1:46158/callback?state=abc&code=secret",
      port: 46158,
    });
  });

  it("preserves a client-generated callback request ID", () => {
    expect(
      validateOAuthCallbackUrl(
        "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&state=abc&iss=https%3A%2F%2Fmcp.example.com",
      ),
    ).toEqual({
      callbackUrl:
        "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&state=abc&iss=https%3A%2F%2Fmcp.example.com",
      port: 46189,
    });
  });

  it.each([
    "https://localhost:46158/callback?code=x",
    "http://example.com:46158/callback?code=x",
    "http://localhost.example.com:46158/callback?code=x",
    "http://user@localhost:46158/callback?code=x",
    "http://localhost:46158/not-callback?code=x",
    "http://localhost:46158/callback/short?code=x",
    "http://localhost:46158/callback/valid-token/nested?code=x",
    "http://localhost:46158/callback/valid.token?code=x",
    "http://localhost:46158/callback",
    "http://localhost:46158/callback?code=x#fragment",
  ])("rejects unsafe callback %s", (callbackUrl) => {
    expect(() => validateOAuthCallbackUrl(callbackUrl)).toThrow(ApiError);
  });
});
