const MAX_OAUTH_RELAY_PAYLOAD_BYTES = 4_096;

export function createOAuthRelayPayload(callbackUrl: string): string {
  if (/[\u0000-\u001f\u007f]/.test(callbackUrl)) {
    throw new Error("OAuth callback contains an unsafe control character");
  }
  if (
    new TextEncoder().encode(callbackUrl).byteLength >
    MAX_OAUTH_RELAY_PAYLOAD_BYTES
  ) {
    throw new Error("OAuth callback relay payload is too long");
  }
  return callbackUrl;
}
