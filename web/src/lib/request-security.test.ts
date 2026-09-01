import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_JSON_BODY_BYTES,
  readJsonBody,
  requireSameOriginJson,
} from "./request-security";

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

describe("readJsonBody", () => {
  it("parses a bounded JSON request", async () => {
    const body = await readJsonBody(
      new Request(`${PUBLIC_ORIGIN}/api/session/start`, {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }),
    );

    expect(body).toEqual({ ok: true });
  });

  it("rejects a declared oversized request before reading it", async () => {
    await expect(
      readJsonBody(
        new Request(`${PUBLIC_ORIGIN}/api/session/start`, {
          method: "POST",
          headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a malformed declared content length", async () => {
    await expect(
      readJsonBody(
        new Request(`${PUBLIC_ORIGIN}/api/session/start`, {
          method: "POST",
          headers: { "content-length": "2bytes" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a streamed request that exceeds the limit", async () => {
    await expect(
      readJsonBody(
        new Request(`${PUBLIC_ORIGIN}/api/session/start`, {
          method: "POST",
          body: JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) }),
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("returns a controlled error for malformed JSON", async () => {
    await expect(
      readJsonBody(
        new Request(`${PUBLIC_ORIGIN}/api/session/start`, {
          method: "POST",
          body: "{",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
