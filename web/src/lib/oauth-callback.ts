import { ApiError } from "./api-error";

const CALLBACK_PATH_PATTERN = /^\/callback(?:\/[A-Za-z0-9_-]{8,128})?$/;
const MAX_CALLBACK_URL_LENGTH = 4_096;

function getRawHostname(rawUrl: string): string | undefined {
  const authority = rawUrl.match(/^http:\/\/([^/?#]+)/i)?.[1];
  if (!authority) return undefined;

  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (hostPort.startsWith("[")) return hostPort.toLowerCase();
  return hostPort.split(":")[0].toLowerCase();
}

export interface ValidatedOAuthCallback {
  callbackUrl: string;
  port: number;
}

export function validateOAuthCallbackUrl(
  input: unknown,
): ValidatedOAuthCallback {
  if (typeof input !== "string") {
    throw new ApiError(400, "Callback URL must be a string");
  }

  const rawUrl = input.trim();
  if (!rawUrl) throw new ApiError(400, "Callback URL is required");
  if (rawUrl.length > MAX_CALLBACK_URL_LENGTH) {
    throw new ApiError(400, "Callback URL is too long");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(400, "Callback URL must be a valid URL");
  }

  if (parsed.protocol !== "http:") {
    throw new ApiError(400, "Callback URL must use http");
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, "Callback URL must not include credentials");
  }

  const hostname = parsed.hostname.toLowerCase();
  const rawHostname = getRawHostname(rawUrl);
  if (
    (rawHostname !== "localhost" && rawHostname !== "127.0.0.1") ||
    (hostname !== "localhost" && hostname !== "127.0.0.1")
  ) {
    throw new ApiError(400, "Callback URL host must be localhost or 127.0.0.1");
  }
  if (!/^\d+$/.test(parsed.port)) {
    throw new ApiError(400, "Callback URL must include a numeric port");
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ApiError(400, "Callback URL port is out of range");
  }
  if (!CALLBACK_PATH_PATTERN.test(parsed.pathname)) {
    throw new ApiError(
      400,
      "Callback URL path must be /callback or /callback/<request-id>",
    );
  }
  if (!parsed.search) {
    throw new ApiError(400, "Callback URL must include a query string");
  }
  if (parsed.hash) {
    throw new ApiError(400, "Callback URL must not include a fragment");
  }

  return {
    callbackUrl: `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`,
    port,
  };
}
