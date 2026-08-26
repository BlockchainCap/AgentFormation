import { NextResponse } from "next/server";
import { ZodError } from "zod";

const NO_STORE = "no-store";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ApiError";
  }
}

export function apiJsonResponse(
  body: unknown,
  init: ResponseInit = {},
): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", NO_STORE);
  return NextResponse.json(body, { ...init, headers });
}

export function apiErrorResponse(error: unknown, event: string): NextResponse {
  if (error instanceof ApiError) {
    return apiJsonResponse(
      { error: error.publicMessage },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return apiJsonResponse({ error: "Invalid request" }, { status: 400 });
  }

  console.error(event, {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return apiJsonResponse({ error: "Request failed" }, { status: 500 });
}
