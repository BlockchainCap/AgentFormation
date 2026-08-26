import { describe, expect, it } from "vitest";
import { createCognitoProvider } from "./auth-provider";

describe("Cognito provider", () => {
  it("sends and verifies its own one-time login value", () => {
    const provider = createCognitoProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      identityProvider: "IdentityCenter",
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
    });

    expect(provider.options?.checks).toEqual(["pkce", "state", "nonce"]);
    expect(provider.options?.authorization).toEqual({
      params: { identity_provider: "IdentityCenter" },
    });
  });
});
