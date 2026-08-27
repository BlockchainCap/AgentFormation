import { z } from "zod";
import { getAwsRegion } from "./env";
import {
  normalizeSsmStreamUrl,
  ssmSessionIdSchema,
  ssmStreamUrlSchema,
} from "./ssm-stream-url";

const tokenSchema = z.string().min(1).max(4_096);

function parseAwsString(
  schema: z.ZodType<string>,
  value: unknown,
  field: string,
): string {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Unexpected SSM ${field}`);
  }
  return result.data;
}

function expectedMessagesHost(): string {
  const region = getAwsRegion();
  const suffix = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  return `ssmmessages.${region}.${suffix}`;
}

function parseStreamUrl(value: unknown, sessionId: string): string {
  const streamUrl = parseAwsString(ssmStreamUrlSchema, value, "stream URL");
  const expectedHost = expectedMessagesHost();
  const normalized = normalizeSsmStreamUrl(
    streamUrl,
    sessionId,
    (hostname) => hostname === expectedHost,
  );
  if (!normalized) {
    throw new Error("Unexpected SSM stream URL");
  }
  return normalized;
}

export interface ValidatedSsmSessionResponse {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
}

export function validateSsmSessionResponse(
  response: {
    SessionId?: unknown;
    StreamUrl?: unknown;
    TokenValue?: unknown;
  },
  expectedSessionId?: string,
): ValidatedSsmSessionResponse {
  const sessionId = parseAwsString(
    ssmSessionIdSchema,
    response.SessionId,
    "session ID",
  );
  if (expectedSessionId && sessionId !== expectedSessionId) {
    throw new Error("SSM resumed an unexpected session");
  }

  return {
    sessionId,
    streamUrl: parseStreamUrl(response.StreamUrl, sessionId),
    tokenValue: parseAwsString(tokenSchema, response.TokenValue, "token"),
  };
}
