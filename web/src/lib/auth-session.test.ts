// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encode } from "next-auth/jwt";
import { NextRequest } from "next/server";

const fixtures = vi.hoisted(() => ({
  secret: "test-secret-with-more-than-thirty-two-bytes",
  subject: "11111111-1111-4111-8111-111111111111",
  getRuntimeForSubject: vi.fn(),
}));

vi.mock("./env", () => ({
  getAuthEnvironment: () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
    identityProvider: "IdentityCenter",
    issuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_example",
    secret: fixtures.secret,
  }),
}));
vi.mock("./registry", () => ({
  getRuntimeForSubject: fixtures.getRuntimeForSubject,
}));

import { handlers } from "./auth";

const cookieName = "__Secure-authjs.session-token";
const thirtyDays = 30 * 24 * 60 * 60;
const signedInAt = new Date("2026-01-01T12:00:00Z");

async function createCookie(maxAge = thirtyDays) {
  return encode({
    secret: fixtures.secret,
    salt: cookieName,
    maxAge,
    token: { subject: fixtures.subject, email: "person@example.com" },
  });
}

function readSession(cookie: string) {
  return handlers.GET(
    new NextRequest("https://agentformation.example/api/auth/session", {
      headers: { cookie: `${cookieName}=${cookie}` },
    }),
  );
}

describe("browser session lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(signedInAt);
    fixtures.getRuntimeForSubject.mockReset();
    fixtures.getRuntimeForSubject.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("renews an existing one-hour login to 30 days in the cookie and token", async () => {
    const response = await readSession(await createCookie(60 * 60));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: fixtures.subject },
      expires: "2026-01-31T12:00:00.000Z",
    });
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${cookieName}=`));
    expect(cookie).toContain("Expires=Sat, 31 Jan 2026 12:00:00 GMT");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const value = cookie?.split(";")[0].slice(cookieName.length + 1);
    const token = await decode({
      token: value,
      secret: fixtures.secret,
      salt: cookieName,
    });
    expect(token?.exp).toBe(signedInAt.getTime() / 1000 + thirtyDays);
  });

  it("renews a login used on day 29 for another 30 days", async () => {
    const cookie = await createCookie();
    vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
    const response = await readSession(cookie);
    expect(await response.json()).toMatchObject({
      user: { id: fixtures.subject },
      expires: "2026-03-01T12:00:00.000Z",
    });
  });

  it.each(["disabled", "purged"])(
    "clears an unexpired 30-day login when access is %s",
    async (status) => {
      const cookie = await createCookie();
      vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
      fixtures.getRuntimeForSubject.mockResolvedValue({ status });
      const response = await readSession(cookie);
      expect(await response.json()).toBeNull();
      expect(response.headers.get("set-cookie")).toContain(
        `${cookieName}=; Max-Age=0`,
      );
      expect(fixtures.getRuntimeForSubject).toHaveBeenCalledWith(
        fixtures.subject,
      );
    },
  );

  it("rejects an unrenewed login after 30 days", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cookie = await createCookie();
    vi.setSystemTime(new Date("2026-02-01T12:00:00Z"));
    const response = await readSession(cookie);
    expect(await response.json()).toBeNull();
    expect(response.headers.get("set-cookie")).toContain(
      `${cookieName}=; Max-Age=0`,
    );
    logError.mockRestore();
  });
});
