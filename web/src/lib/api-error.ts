import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: unknown, event: string): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.publicMessage },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  console.error(event, {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}
