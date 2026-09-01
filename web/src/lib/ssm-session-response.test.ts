import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateSsmSessionResponse } from "./ssm-session-response";

const SESSION_ID = "session-123";

describe("validateSsmSessionResponse", () => {
  beforeEach(() => {
    process.env.AWS_REGION = "us-west-2";
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
  });

  it("accepts the expected regional SSM Messages endpoint", () => {
    expect(
      validateSsmSessionResponse(
        {
          SessionId: SESSION_ID,
          StreamUrl: `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}?stream=input`,
          TokenValue: "encrypted-token",
        },
        SESSION_ID,
      ),
    ).toMatchObject({ sessionId: SESSION_ID });
  });

  it("pins the endpoint to the current region and partition", () => {
    expect(() =>
      validateSsmSessionResponse({
        SessionId: SESSION_ID,
        StreamUrl: `wss://ssmmessages.us-east-1.amazonaws.com/v1/data-channel/${SESSION_ID}`,
        TokenValue: "encrypted-token",
      }),
    ).toThrow("Unexpected SSM stream URL");

    process.env.AWS_REGION = "cn-north-1";
    expect(
      validateSsmSessionResponse({
        SessionId: SESSION_ID,
        StreamUrl: `wss://ssmmessages.cn-north-1.amazonaws.com.cn/v1/data-channel/${SESSION_ID}`,
        TokenValue: "encrypted-token",
      }),
    ).toMatchObject({ sessionId: SESSION_ID });
  });

  it("rejects an unexpected stream host", () => {
    for (const StreamUrl of [
      `wss://attacker.example/v1/data-channel/${SESSION_ID}`,
      `wss://ssmmessages.us-west-2.amazonaws.com:8443/v1/data-channel/${SESSION_ID}`,
    ]) {
      expect(() =>
        validateSsmSessionResponse({
          SessionId: SESSION_ID,
          StreamUrl,
          TokenValue: "encrypted-token",
        }),
      ).toThrow("Unexpected SSM stream URL");
    }
  });

  it("rejects stream URLs with credentials or fragments", () => {
    for (const StreamUrl of [
      `wss://user@ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}`,
      `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}#other`,
    ]) {
      expect(() =>
        validateSsmSessionResponse({
          SessionId: SESSION_ID,
          StreamUrl,
          TokenValue: "encrypted-token",
        }),
      ).toThrow("Unexpected SSM stream URL");
    }
  });

  it("rejects deceptive stream host spellings", () => {
    for (const StreamUrl of [
      `wss://ssmmessages.us-west-2.amazonaws.com.attacker.example/v1/data-channel/${SESSION_ID}`,
      `wss://ssmmessages.us-west-2.amazonaws.com./v1/data-channel/${SESSION_ID}`,
      `wss://ssmmessages.us-west-2.amazonaws.com\\@attacker.example/v1/data-channel/${SESSION_ID}`,
      `wss://127.0.0.1/v1/data-channel/${SESSION_ID}`,
      `wss://ssmmessages%2eus-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}`,
    ]) {
      expect(() =>
        validateSsmSessionResponse({
          SessionId: SESSION_ID,
          StreamUrl,
          TokenValue: "encrypted-token",
        }),
      ).toThrow();
    }
  });

  it("bounds the AWS stream URL before parsing it", () => {
    expect(() =>
      validateSsmSessionResponse({
        SessionId: SESSION_ID,
        StreamUrl: `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}?padding=${"a".repeat(8_192)}`,
        TokenValue: "encrypted-token",
      }),
    ).toThrow("Unexpected SSM stream URL");
  });

  it("rejects a mismatched resumed session", () => {
    expect(() =>
      validateSsmSessionResponse(
        {
          SessionId: "different-session",
          StreamUrl: `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/different-session`,
          TokenValue: "encrypted-token",
        },
        SESSION_ID,
      ),
    ).toThrow("SSM resumed an unexpected session");
  });

  it("binds the stream path to the returned session", () => {
    for (const StreamUrl of [
      "wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/another-session",
      `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/%73ession-123`,
      `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/session%2F123`,
      `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/ignored/../${SESSION_ID}`,
    ]) {
      expect(() =>
        validateSsmSessionResponse({
          SessionId: SESSION_ID,
          StreamUrl,
          TokenValue: "encrypted-token",
        }),
      ).toThrow("Unexpected SSM stream URL");
    }
  });

  it("turns malformed AWS response fields into internal errors", () => {
    const response = {
      SessionId: "x".repeat(97),
      StreamUrl: `wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/${SESSION_ID}`,
      TokenValue: "encrypted-token",
    };

    expect(() => validateSsmSessionResponse(response)).toThrow(
      "Unexpected SSM session ID",
    );
    try {
      validateSsmSessionResponse(response);
    } catch (error) {
      expect(error).toMatchObject({ name: "Error" });
    }
  });
});
