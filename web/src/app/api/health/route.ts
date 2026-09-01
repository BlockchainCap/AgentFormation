import { apiJsonResponse } from "@/lib/api-error";
import { validateApplicationEnvironment } from "@/lib/env";

export function GET() {
  try {
    validateApplicationEnvironment();
    return apiJsonResponse({ status: "ok" });
  } catch (error) {
    console.error("health.configuration.invalid", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return apiJsonResponse({ status: "unavailable" }, { status: 503 });
  }
}
