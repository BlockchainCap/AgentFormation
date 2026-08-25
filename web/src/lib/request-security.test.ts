import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireSameOriginJson } from "./request-security";

const PUBLIC_ORIGIN = "https://agentformation.example";

function request(headers: Record<string, string>): Request {
  return new Request(`${PUBLIC_ORIGIN}/api/session/start`, {
    method: "POST",
    headers,
  });
}

describe("requireSameOriginJson", () => {
  beforeEach(() => {
    process.env.AUTH_URL = PUBLIC_ORIGIN;
  });

  afterEach(() => {
    delete process.env.AUTH_URL;
  });

  it("accepts same-origin JSON requests", () => {
    expect(() =>
      requireSameOriginJson(
        request({
          origin: PUBLIC_ORIGIN,
          "content-type": "application/json; charset=utf-8",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).not.toThrow();
  });

  it.each([undefined, "https://attacker.invalid"])(
    "rejects a missing or different origin",
    (origin) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (origin) headers.origin = origin;

      expect(() => requireSameOriginJson(request(headers))).toThrowError(
        expect.objectContaining({ status: 403 }),
      );
    },
  );

  it("rejects a browser-marked cross-site request", () => {
    expect(() =>
      requireSameOriginJson(
        request({
          origin: PUBLIC_ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it("rejects a simple form content type", () => {
    expect(() =>
      requireSameOriginJson(
        request({
          origin: PUBLIC_ORIGIN,
          "content-type": "text/plain",
        }),
      ),
    ).toThrowError(expect.objectContaining({ status: 415 }));
  });
});
