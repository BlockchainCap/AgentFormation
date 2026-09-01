import { describe, expect, it } from "vitest";
import {
  getAttachmentSubmitSuffix,
  isS3UploadUrl,
  readSessionResponse,
  readUploadCompleteResponse,
} from "./terminal-api";

const sessionId = "maintainer-session-123";
const validSession = {
  sessionId,
  streamUrl: `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${sessionId}?role=publish_subscribe`,
  tokenValue: "session-token",
  terminateToken: "termination-proof",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("terminal API response boundaries", () => {
  it("accepts only the expected Systems Manager websocket endpoint", async () => {
    await expect(
      readSessionResponse(jsonResponse(validSession)),
    ).resolves.toEqual(validSession);

    for (const streamUrl of [
      `ws://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${sessionId}`,
      `wss://ssmmessages.us-west-2.amazonaws.com:444/v1/data-channel/${sessionId}`,
      `wss://attacker.example/v1/data-channel/${sessionId}`,
      `wss://user:password@ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${sessionId}`,
      `wss://ssmmessages.us-west-2.amazonaws.com.attacker.example/v1/data-channel/${sessionId}`,
      `wss://ssmmessages.us-west-2.amazonaws.com./v1/data-channel/${sessionId}`,
      `wss://ssmmessages.us-west-2.amazonaws.com\\@attacker.example/v1/data-channel/${sessionId}`,
      `wss://127.0.0.1/v1/data-channel/${sessionId}`,
      `wss://ssmmessages%2eus-west-2.amazonaws.com/v1/data-channel/${sessionId}`,
      `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${sessionId}#other`,
      `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/another-session`,
    ]) {
      await expect(
        readSessionResponse(jsonResponse({ ...validSession, streamUrl })),
      ).rejects.toThrow("Unexpected SSM session endpoint");
    }
  });

  it("accepts AWS principal characters in a returned session ID", async () => {
    const principalSessionId = "person+team=ops,user@example.com-session_1.2";
    const response = {
      ...validSession,
      sessionId: principalSessionId,
      streamUrl: `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${principalSessionId}?role=publish_subscribe`,
    };

    await expect(readSessionResponse(jsonResponse(response))).resolves.toEqual(
      response,
    );
  });

  it("bounds the websocket URL before parsing it", async () => {
    await expect(
      readSessionResponse(
        jsonResponse({
          ...validSession,
          streamUrl: `${validSession.streamUrl}&padding=${"a".repeat(8_192)}`,
        }),
      ),
    ).rejects.toThrow("Incomplete SSM session response");
  });

  it("accepts only generated upload paths and quotes them in agent input", async () => {
    const upload = {
      path: "/workspace/.uploads/22222222-2222-4222-8222-222222222222/notes.txt",
      filename: "notes.txt",
      mimeType: "text/plain",
      fileSize: 12,
    };
    await expect(
      readUploadCompleteResponse(jsonResponse(upload)),
    ).resolves.toEqual(upload);
    expect(
      getAttachmentSubmitSuffix("review", [{ ...upload, id: "attachment-1" }]),
    ).toBe(` attached file: '${upload.path}' `);

    await expect(
      readUploadCompleteResponse(
        jsonResponse({
          ...upload,
          path: `${upload.path}\nrm -rf /tmp/data`,
        }),
      ),
    ).rejects.toThrow("Server returned an invalid response");

    for (const path of [
      "/workspace/.uploads/22222222-2222-4222-8222-222222222222/it's.txt",
      "/workspace/.uploads/22222222-2222-4222-8222-222222222222/two words.txt",
    ]) {
      await expect(
        readUploadCompleteResponse(jsonResponse({ ...upload, path })),
      ).rejects.toThrow("Server returned an invalid response");
    }
  });

  it("accepts HTTPS AWS S3 upload hosts only", () => {
    expect(isS3UploadUrl("https://uploads.s3.us-west-2.amazonaws.com")).toBe(
      true,
    );
    expect(isS3UploadUrl("https://uploads.s3.amazonaws.com.cn")).toBe(true);
    expect(isS3UploadUrl("http://uploads.s3.amazonaws.com")).toBe(false);
    expect(isS3UploadUrl("https://s3.attacker.example")).toBe(false);
    expect(isS3UploadUrl("https://uploads.s3.amazonaws.com:8443")).toBe(false);
    expect(isS3UploadUrl("not a URL")).toBe(false);
  });
});
