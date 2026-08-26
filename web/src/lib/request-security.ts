import { ApiError } from "./api-error";
import { getPublicOrigin } from "./env";

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
