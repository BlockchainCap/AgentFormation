#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v bun >/dev/null 2>&1 || { echo "bun is required" >&2; exit 1; }
command -v shellcheck >/dev/null 2>&1 || { echo "shellcheck is required" >&2; exit 1; }

cd "$ROOT_DIR/web"
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run test
AUTH_SECRET=build-only-secret-with-at-least-32-characters \
AUTH_COGNITO_ID=build-client \
AUTH_COGNITO_SECRET=build-secret \
AUTH_COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_build \
AWS_REGION=us-east-1 \
USER_REGISTRY_TABLE=build-users \
UPLOAD_BUCKET=build-uploads \
SESSION_DOCUMENT_NAME=build-terminal \
  bun run build

cd "$ROOT_DIR"
shellcheck -x -P SCRIPTDIR agentformation scripts/*.sh scripts/lib/*.sh
if command -v cfn-lint >/dev/null 2>&1; then
  cfn-lint templates/*.yaml
elif command -v uvx >/dev/null 2>&1; then
  uvx cfn-lint==1.55.1 templates/*.yaml
else
  echo "cfn-lint or uvx is required" >&2
  exit 1
fi

echo "AgentFormation checks passed"
