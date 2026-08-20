#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

for command in aws docker git jq; do require_command "$command"; done
docker buildx version >/dev/null || fail "Docker buildx is required"
require_config

say "Checking local configuration"
config '.deploymentName | test("^[a-z][a-z0-9-]{2,31}$")' >/dev/null
config '.networkMode == "private-nat" or .networkMode == "private-endpoints"' >/dev/null
config '(.cloudFormationRoleArn // "") | . == "" or test("^arn:aws[^:]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$")' >/dev/null
config '.runtime.architecture == "arm64" or .runtime.architecture == "x86_64"' >/dev/null
config '.runtime.instanceType | test("^[a-z0-9.]+$")' >/dev/null
config '.runtime.volumeSizeGiB | type == "number" and . >= 20 and . <= 1024' >/dev/null
config '.models.claude | test("^[A-Za-z0-9._:/-]+$")' >/dev/null
config '.models.codex | test("^[A-Za-z0-9._:/-]+$")' >/dev/null
config '.versions.claudeCode | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")' >/dev/null
config '.versions.codex | test("^[0-9]+\\.[0-9]+\\.[0-9]+([-.][A-Za-z0-9.]+)?$")' >/dev/null
config '.users | type == "array" and length > 0' >/dev/null
config '[.users[].email | ascii_downcase] | all(test("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$"))' >/dev/null
config '[.users[].email | ascii_downcase] | length == (unique | length)' >/dev/null

say "Checking AWS credentials and region"
aws_cli sts get-caller-identity --query Arn --output text | sed -E 's#arn:aws[^:]*:iam::[0-9]+:#arn:aws:iam::<account>:#; s#arn:aws[^:]*:sts::[0-9]+:#arn:aws:sts::<account>:#'

say "Checking required AWS services"
aws_cli bedrock list-foundation-models --query 'length(modelSummaries)' --output text >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/network.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/foundation.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/image.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/runtime.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/web.yaml" >/dev/null

say "Checking configured Bedrock model names"
CLAUDE_MODEL="$(config '.models.claude')"
CODEX_MODEL="$(config '.models.codex')"
aws_cli bedrock list-foundation-models --query "modelSummaries[?modelId=='$CODEX_MODEL'].modelId | [0]" --output text | grep -F "$CODEX_MODEL" >/dev/null || \
  say "Codex model is not returned by list-foundation-models; deploy will verify it with the live CLI test"
[[ -n "$CLAUDE_MODEL" ]] || fail "Claude model must not be empty"

say "Doctor checks passed"
