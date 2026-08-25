FROM docker.io/library/node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ARG BUN_VERSION=1.3.6
RUN apk upgrade --no-cache && \
    npm install --global "bun@${BUN_VERSION}"

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM base AS builder
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
    AGENTFORMATION_DEPLOYMENT=agentformation \
    PROVISIONING_STATE_MACHINE_ARN=arn:aws:states:us-east-1:000000000000:stateMachine:build-only \
    USER_REGISTRY_TABLE=build-only \
    UPLOAD_BUCKET=build-only \
    SESSION_DOCUMENT_NAME=build-only \
    bun run build

FROM docker.io/library/node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk upgrade --no-cache && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs start.mjs ./start.mjs

USER nextjs
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "start.mjs"]
