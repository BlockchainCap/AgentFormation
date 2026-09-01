import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type SignInCallback = (input: { profile?: unknown }) => Promise<boolean>;
type JwtCallback = (input: {
  token: { subject?: string; email?: string };
  profile?: unknown;
}) => Promise<{ subject?: string; email?: string } | null>;

interface CapturedAuthConfiguration {
  callbacks: {
    signIn: SignInCallback;
    jwt: JwtCallback;
  };
}

const mocks = vi.hoisted(() => ({
  configuration: undefined as CapturedAuthConfiguration | undefined,
  getRuntimeForSubject: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (configuration: CapturedAuthConfiguration) => {
    mocks.configuration = configuration;
    return {
      handlers: {},
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));

vi.mock("./auth-provider", () => ({
  createCognitoProvider: vi.fn(() => ({ id: "cognito" })),
}));

vi.mock("./env", () => ({
  getAuthEnvironment: vi.fn(() => ({
    clientId: "client-id",
    clientSecret: "client-secret",
    identityProvider: "IdentityCenter",
    issuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_example",
    secret: "test-secret-with-more-than-thirty-two-bytes",
  })),
}));

vi.mock("./registry", () => ({
  getRuntimeForSubject: mocks.getRuntimeForSubject,
}));

describe("sign-in access revocation", () => {
  beforeAll(async () => {
    await import("./auth");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["disabled", "purged"] as const)(
    "rejects a valid federated profile whose runtime is %s",
    async (status) => {
      mocks.getRuntimeForSubject.mockResolvedValue({ status });

      const allowed = await mocks.configuration?.callbacks.signIn({
        profile: {
          sub: "11111111-1111-4111-8111-111111111111",
          email: "Person@Example.com",
        },
      });

      expect(allowed).toBe(false);
      expect(mocks.getRuntimeForSubject).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
      );
    },
  );

  it("allows a valid federated profile with no revoked registry marker", async () => {
    mocks.getRuntimeForSubject.mockResolvedValue(undefined);

    const allowed = await mocks.configuration?.callbacks.signIn({
      profile: {
        sub: "11111111-1111-4111-8111-111111111111",
        email: "Person@Example.com",
      },
    });

    expect(allowed).toBe(true);
  });

  it.each(["disabled", "purged"] as const)(
    "clears a rolling JWT session after access becomes %s",
    async (status) => {
      mocks.getRuntimeForSubject.mockResolvedValue({ status });

      const token = await mocks.configuration?.callbacks.jwt({
        token: {
          subject: "11111111-1111-4111-8111-111111111111",
          email: "person@example.com",
        },
      });

      expect(token).toBeNull();
      expect(mocks.getRuntimeForSubject).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
      );
    },
  );

  it("keeps a non-revoked JWT session", async () => {
    mocks.getRuntimeForSubject.mockResolvedValue(undefined);
    const originalToken = {
      subject: "11111111-1111-4111-8111-111111111111",
      email: "person@example.com",
    };

    const token = await mocks.configuration?.callbacks.jwt({
      token: originalToken,
    });

    expect(token).toBe(originalToken);
  });
});
