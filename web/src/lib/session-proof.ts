import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthEnvironment } from "./env";

function createPayload(subject: string, sessionId: string): string {
  return `${subject}:${sessionId}`;
}

export function createTerminateToken(
  subject: string,
  sessionId: string,
): string {
  return createHmac("sha256", getAuthEnvironment().secret)
    .update(createPayload(subject, sessionId))
    .digest("base64url");
}

export function verifyTerminateToken(
  subject: string,
  sessionId: string,
  token: string,
): boolean {
  const expected = createTerminateToken(subject, sessionId);

  try {
    return timingSafeEqual(
      Buffer.from(expected, "base64url"),
      Buffer.from(token, "base64url"),
    );
  } catch {
    return false;
  }
}
