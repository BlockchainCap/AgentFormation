import { apiJsonResponse } from "@/lib/api-error";

export function GET() {
  return apiJsonResponse({ status: "ok" });
}
