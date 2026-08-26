import { shellQuote } from "./shell";

const CURL_TIMEOUT_SECONDS = 5;

export function serializeOAuthCallbackForCurl(callbackUrl: string): string {
  const escapedUrl = callbackUrl
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `url = "${escapedUrl}"\n`;
}

export function buildOAuthRelayCommands(
  bucket: string,
  objectKey: string,
): string[] {
  const objectUri = `s3://${bucket}/${objectKey}`;

  return [
    "oauth_callback_config=$(mktemp)",
    "trap 'rm -f \"$oauth_callback_config\"' EXIT",
    `aws s3 cp ${shellQuote(objectUri)} "$oauth_callback_config" --only-show-errors`,
    'chmod 600 "$oauth_callback_config"',
    [
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--output /dev/null",
      `--max-time ${CURL_TIMEOUT_SECONDS}`,
      '--config "$oauth_callback_config"',
    ].join(" "),
  ];
}
