import { ApiError } from "./api-error";
import { getPublicOrigin } from "./env";

export const MAX_JSON_BODY_BYTES = 16 * 1024;

export function requireSameOriginJson(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== getPublicOrigin() || fetchSite === "cross-site") {
    throw new ApiError(403, "Forbidden");
  }

  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(415, "Content type must be application/json");
  }
}

function declaredBodySize(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;

  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "Invalid content length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, "Invalid content length");
  }
  return parsed;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredSize = declaredBodySize(request);
  if (declaredSize !== undefined && declaredSize > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large");
  }

  if (!request.body) {
    throw new ApiError(400, "Invalid JSON request");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "Invalid JSON request");
  }
}
