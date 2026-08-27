FROM --platform=$BUILDPLATFORM docker.io/library/node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build-base
ARG BUN_VERSION=1.3.6
RUN apk upgrade --no-cache && \
    npm install --global "bun@${BUN_VERSION}"

FROM build-base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM build-base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN mkdir -p public && \
    AUTH_SECRET=build-only-secret-not-used-at-runtime \
    AUTH_COGNITO_ID=build-only \
    AUTH_COGNITO_SECRET=build-only \
    AUTH_COGNITO_IDENTITY_PROVIDER=IdentityCenter \
    AUTH_COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_build \
    AUTH_URL=https://agentformation.example \
    AWS_REGION=us-east-1 \
    AGENTFORMATION_DEPLOYMENT=agentformation \
    CONTROL_TABLE=build-only \
    PROVISIONING_STATE_MACHINE_ARN=arn:aws:states:us-east-1:000000000000:stateMachine:build-only \
    USER_REGISTRY_TABLE=build-only \
    UPLOAD_BUCKET=build-only \
    SESSION_DOCUMENT_NAME=build-only \
    UPLOAD_DELIVERY_DOCUMENT_NAME=build-only \
    OAUTH_RELAY_DOCUMENT_NAME=build-only \
    bun run build

# Build the Next.js application on the host architecture. Turbopack is not
# reliable under QEMU, while App Runner still needs an amd64 image. Install the
# small set of traced native runtime dependencies for the requested target so a
# native arm64 build never ships arm64 Sharp binaries in the amd64 image.
FROM docker.io/library/node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime-deps
ARG BUN_VERSION=1.3.6
WORKDIR /app
RUN apk upgrade --no-cache && \
    npm install --global "bun@${BUN_VERSION}"
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM docker.io/library/node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk upgrade --no-cache && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=runtime-deps --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp
COPY --from=runtime-deps --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img
COPY --chown=nextjs:nodejs start.mjs ./start.mjs
RUN node -e "require('sharp')"

USER nextjs
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "start.mjs"]
