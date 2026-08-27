import { describe, expect, it } from "vitest";
import { isValidSsmSessionId, normalizeSsmStreamUrl } from "./ssm-stream-url";

const SESSION_ID = "maintainer-session-123";
const HOST = "ssmmessages.us-west-2.amazonaws.com";
const isAllowedHost = (hostname: string) => hostname === HOST;

function normalize(streamUrl: string, sessionId = SESSION_ID) {
  return normalizeSsmStreamUrl(streamUrl, sessionId, isAllowedHost);
}

describe("SSM stream URL validation", () => {
  it("accepts the exact channel endpoint and its required bounded query", () => {
    const streamUrl = `wss://${HOST}/v1/data-channel/${SESSION_ID}?role=publish_subscribe`;

    expect(normalize(streamUrl)).toBe(streamUrl);
  });

  it("accepts session IDs built from AWS principal-name characters", () => {
    const sessionId = "person+team=ops,user@example.com-session_1.2";
    const streamUrl = `wss://${HOST}/v1/data-channel/${sessionId}?stream=input`;

    expect(isValidSsmSessionId(sessionId)).toBe(true);
    expect(normalize(streamUrl, sessionId)).toBe(streamUrl);
  });

  it("rejects invalid or oversized session IDs", () => {
    for (const sessionId of [
      "",
      "session/other",
      "session%2Fother",
      "session\nother",
      "x".repeat(97),
    ]) {
      expect(isValidSsmSessionId(sessionId)).toBe(false);
    }
  });

  it("rejects alternate authorities and insecure transports", () => {
    for (const streamUrl of [
      `ws://${HOST}/v1/data-channel/${SESSION_ID}`,
      `wss:${HOST}/v1/data-channel/${SESSION_ID}`,
      `wss://${HOST}:444/v1/data-channel/${SESSION_ID}`,
      `wss://${HOST}:0/v1/data-channel/${SESSION_ID}`,
      `wss://user:password@${HOST}/v1/data-channel/${SESSION_ID}`,
      `wss://attacker.example/v1/data-channel/${SESSION_ID}`,
      `wss://${HOST}.attacker.example/v1/data-channel/${SESSION_ID}`,
      `wss://${HOST}./v1/data-channel/${SESSION_ID}`,
      `wss://${HOST}\\@attacker.example/v1/data-channel/${SESSION_ID}`,
      `wss://127.0.0.1/v1/data-channel/${SESSION_ID}`,
      `wss://ssmmessages%2eus-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}`,
    ]) {
      expect(normalize(streamUrl)).toBeNull();
    }
  });

  it("rejects mismatched, encoded, and normalized-away channel paths", () => {
    for (const streamUrl of [
      `wss://${HOST}/v1/data-channel/another-session`,
      `wss://${HOST}/v1/data-channel/%6Daintainer-session-123`,
      `wss://${HOST}/v1/data-channel/maintainer%2Fsession-123`,
      `wss://${HOST}/v1/data-channel/ignored/../${SESSION_ID}`,
      `wss://${HOST}/v1/data-channel/${SESSION_ID}/`,
    ]) {
      expect(normalize(streamUrl)).toBeNull();
    }
  });

  it("rejects fragments and oversized URLs without exposing their contents", () => {
    expect(
      normalize(`wss://${HOST}/v1/data-channel/${SESSION_ID}#other`),
    ).toBeNull();
    expect(
      normalize(
        `wss://${HOST}/v1/data-channel/${SESSION_ID}?padding=${"a".repeat(8_192)}`,
      ),
    ).toBeNull();
  });
});
