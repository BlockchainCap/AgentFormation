import { NextResponse } from "next/server";

const APP_VERSION = process.env.npm_package_version ?? "0.1.0";

export function GET() {
  return NextResponse.json({
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
}
