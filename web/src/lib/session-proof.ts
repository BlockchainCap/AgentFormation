import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getAuthEnvironment } from "./env";

export const SESSION_CONTROL_TOKEN_TTL_SECONDS = 13 * 60 * 60;
const base64UrlSchema = /^[A-Za-z0-9_-]+$/;
const hmacSignatureSchema = /^[A-Za-z0-9_-]{43}$/;

const claimsSchema = z.object({
  version: z.literal(1),
  subject: z.string().uuid(),
  sessionId: z.string().min(1).max(96),
  instanceId: z.string().regex(/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/),
  expiresAt: z.number().int().positive(),
});

function signPayload(payload: string): string {
  return createHmac("sha256", getAuthEnvironment().secret)
    .update(payload)
    .digest("base64url");
}

export function createTerminateToken(
  subject: string,
  sessionId: string,
  instanceId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const parsedClaims = claimsSchema.safeParse({
    version: 1,
    subject,
    sessionId,
    instanceId,
    expiresAt: nowSeconds + SESSION_CONTROL_TOKEN_TTL_SECONDS,
  });
  if (!parsedClaims.success) {
    throw new Error("Unable to create session control token");
  }
  const claims = parsedClaims.data;
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

export function verifyTerminateToken(
  subject: string,
  sessionId: string,
  instanceId: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length > 0) return false;
  if (!base64UrlSchema.test(payload) || !hmacSignatureSchema.test(signature)) {
    return false;
  }

  try {
    const payloadBytes = Buffer.from(payload, "base64url");
    if (payloadBytes.toString("base64url") !== payload) return false;
    const expectedSignature = signPayload(payload);
    if (
      !timingSafeEqual(
        Buffer.from(expectedSignature, "ascii"),
        Buffer.from(signature, "ascii"),
      )
    ) {
      return false;
    }

    const claims = claimsSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")),
    );
    return (
      claims.subject === subject &&
      claims.sessionId === sessionId &&
      claims.instanceId === instanceId &&
      claims.expiresAt >= nowSeconds &&
      claims.expiresAt <= nowSeconds + SESSION_CONTROL_TOKEN_TTL_SECONDS
    );
  } catch {
    return false;
  }
}
