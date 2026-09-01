import { z } from "zod";

export const SSM_STREAM_URL_MAX_LENGTH = 8_192;
export const SSM_SESSION_ID_MAX_LENGTH = 96;

// Systems Manager builds session IDs from AWS principal names. IAM user and
// STS role-session names allow these punctuation characters in addition to
// ASCII letters and digits.
export const ssmSessionIdSchema = z
  .string()
  .min(1)
  .max(SSM_SESSION_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_+=,.@-]+$/);

export const ssmStreamUrlSchema = z
  .string()
  .max(SSM_STREAM_URL_MAX_LENGTH)
  .url();

export function isValidSsmSessionId(value: string): boolean {
  return ssmSessionIdSchema.safeParse(value).success;
}

export function normalizeSsmStreamUrl(
  streamUrl: string,
  sessionId: string,
  isAllowedHostname: (hostname: string) => boolean,
): string | null {
  if (
    !isValidSsmSessionId(sessionId) ||
    streamUrl.length > SSM_STREAM_URL_MAX_LENGTH ||
    !streamUrl.startsWith("wss://")
  ) {
    return null;
  }

  try {
    const afterScheme = streamUrl.slice("wss://".length);
    const authorityEnd = afterScheme.search(/[/?#\\]/);
    if (authorityEnd < 0) return null;

    const rawAuthority = afterScheme.slice(0, authorityEnd);
    const rawPath = afterScheme.slice(authorityEnd).split(/[?#]/, 1)[0];
    const expectedPath = `/v1/data-channel/${sessionId}`;
    const url = new URL(streamUrl);

    if (
      url.protocol !== "wss:" ||
      rawAuthority.includes("%") ||
      url.username ||
      url.password ||
      url.port ||
      !isAllowedHostname(url.hostname) ||
      rawPath !== expectedPath ||
      url.pathname !== expectedPath ||
      url.hash
    ) {
      return null;
    }

    // The bounded query is required by SSM for the channel role. Return the
    // normalized URL, but never include it in validation errors or logs.
    return url.href;
  } catch {
    return null;
  }
}
