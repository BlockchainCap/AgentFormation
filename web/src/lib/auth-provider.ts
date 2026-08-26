import Cognito from "next-auth/providers/cognito";

interface CognitoProviderEnvironment {
  clientId: string;
  clientSecret: string;
  identityProvider: string;
  issuer: string;
}

export function createCognitoProvider(environment: CognitoProviderEnvironment) {
  return Cognito({
    clientId: environment.clientId,
    clientSecret: environment.clientSecret,
    issuer: environment.issuer,
    checks: ["pkce", "state", "nonce"],
    authorization: {
      params: { identity_provider: environment.identityProvider },
    },
  });
}
