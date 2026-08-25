import { describe, expect, it } from "vitest";
import {
  buildOAuthRelayCommands,
  serializeOAuthCallbackForCurl,
} from "./oauth-relay";

describe("OAuth callback relay staging", () => {
  it("stores the callback as a curl config without putting it in the command", () => {
    const callbackUrl =
      "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&path=one\\two";
    const commands = buildOAuthRelayCommands(
      "upload-bucket",
      "uploads/user/id/oauth-callback.curl",
    );

    expect(serializeOAuthCallbackForCurl(callbackUrl)).toBe(
      'url = "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&path=one\\\\two"\n',
    );
    expect(commands.join("\n")).not.toContain("code=secret");
    expect(commands.join("\n")).toContain(
      "s3://upload-bucket/uploads/user/id/oauth-callback.curl",
    );
    expect(commands.at(-1)).toContain('--config "$oauth_callback_config"');
  });
});
