export function contentSecurityPolicy(
  nonce: string,
  awsRegion: string,
  isDevelopment: boolean,
): string {
  const developmentScriptSource = isDevelopment ? " 'unsafe-eval'" : "";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScriptSource}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' wss://ssmmessages.${awsRegion}.amazonaws.com https://*.s3.${awsRegion}.amazonaws.com https://*.s3.amazonaws.com`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
