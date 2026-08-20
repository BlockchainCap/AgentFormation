import { StartSessionCommand } from "@aws-sdk/client-ssm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-error";
import { requireAuthorizedRuntime } from "@/lib/authorization";
import { getSsmClient } from "@/lib/aws";
import { getSessionDocumentName } from "@/lib/env";
import { createTerminateToken } from "@/lib/session-proof";

const requestSchema = z.object({
  tmuxSession: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default("code"),
  termOptions: z
    .object({
      cols: z.number().int().min(20).max(240),
      rows: z.number().int().min(5).max(200),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { subject, runtime } = await requireAuthorizedRuntime();
    const body = requestSchema.parse(await request.json().catch(() => ({})));
    const response = await getSsmClient().send(
      new StartSessionCommand({
        Target: runtime.instanceId,
        DocumentName: getSessionDocumentName(),
        Parameters: { tmuxSession: [body.tmuxSession] },
        Reason: "AgentFormation browser terminal",
      }),
    );

    if (!response.SessionId || !response.StreamUrl || !response.TokenValue) {
      throw new Error("Incomplete SSM session response");
    }

    return NextResponse.json({
      sessionId: response.SessionId,
      streamUrl: response.StreamUrl,
      tokenValue: response.TokenValue,
      terminateToken: createTerminateToken(subject, response.SessionId),
    });
  } catch (error) {
    return apiErrorResponse(error, "session.start.failed");
  }
}
