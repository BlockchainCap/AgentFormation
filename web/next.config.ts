import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const awsRegion = process.env.AWS_REGION ?? "us-east-1";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              `connect-src 'self' wss://*.amazonaws.com https://*.s3.${awsRegion}.amazonaws.com https://*.s3.amazonaws.com`,
              "font-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self' https://*.auth.*.amazoncognito.com https://*.amazoncognito.com",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
