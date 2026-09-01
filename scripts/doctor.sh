#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

for command in aws docker git jq; do require_command "$command"; done
docker buildx version >/dev/null || fail "Docker buildx is required"
require_config

say "Checking local configuration"
config '.deploymentName | test("^[a-z][a-z0-9-]{2,31}$") and (contains("-runtime-") | not)' >/dev/null
config '(.publicUrl // "") | type == "string" and (. == "" or test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$"))' >/dev/null
config '.networkMode == "private-nat" or .networkMode == "private-endpoints"' >/dev/null
config '(.identityCenter.metadataUrl // "") | type == "string" and (. == "" or test("^https://[^[:space:]]+$"))' >/dev/null
config '(.identityCenter.metadataFile // "") | type == "string"' >/dev/null
config '(.cloudFormationRoleArn // "") | . == "" or test("^arn:aws[^:]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$")' >/dev/null
config '.runtime.architecture == "arm64" or .runtime.architecture == "x86_64"' >/dev/null
config '.runtime.instanceType | test("^[a-z0-9.]+$")' >/dev/null
config '.runtime.volumeSizeGiB | type == "number" and . >= 20 and . <= 1024' >/dev/null
config '.models.claude | test("^[A-Za-z0-9._:/-]+$")' >/dev/null
config '.models.codex | test("^[A-Za-z0-9._:/-]+$")' >/dev/null
config '.versions.awsCli | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")' >/dev/null
config '.versions.node | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")' >/dev/null
config '.versions.bun | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")' >/dev/null
config '.versions.claudeCode | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")' >/dev/null
config '.versions.codex | test("^[0-9]+\\.[0-9]+\\.[0-9]+([-.][A-Za-z0-9.]+)?$")' >/dev/null

if config 'has("users")' >/dev/null; then
  say "The users list is no longer used; IAM Identity Center assignments now control access"
fi

IDENTITY_CENTER_METADATA_URL="$(config '.identityCenter.metadataUrl // ""')"
IDENTITY_CENTER_METADATA_FILE="$(config '.identityCenter.metadataFile // ""')"
if [[ -n "$IDENTITY_CENTER_METADATA_URL" && -n "$IDENTITY_CENTER_METADATA_FILE" ]]; then
  fail "Set only one of identityCenter.metadataUrl or identityCenter.metadataFile"
fi
if [[ -n "$IDENTITY_CENTER_METADATA_FILE" ]]; then
  if [[ "$IDENTITY_CENTER_METADATA_FILE" != /* ]]; then
    IDENTITY_CENTER_METADATA_FILE="$ROOT_DIR/$IDENTITY_CENTER_METADATA_FILE"
  fi
  [[ -f "$IDENTITY_CENTER_METADATA_FILE" ]] || fail "identityCenter.metadataFile does not point to a readable file"
  [[ "$(wc -c <"$IDENTITY_CENTER_METADATA_FILE")" -le 131072 ]] || \
    fail "identityCenter.metadataFile exceeds Cognito's 131072-byte limit"
  grep -E '<([[:alnum:]_.-]+:)?EntityDescriptor([[:space:]>])' "$IDENTITY_CENTER_METADATA_FILE" >/dev/null || \
    fail "identityCenter.metadataFile is not a SAML metadata document"
fi

say "Checking AWS credentials and region"
aws_cli sts get-caller-identity --query Arn --output text | sed -E 's#arn:aws[^:]*:iam::[0-9]+:#arn:aws:iam::<account>:#; s#arn:aws[^:]*:sts::[0-9]+:#arn:aws:sts::<account>:#'

say "Checking required AWS services"
aws_cli bedrock list-foundation-models --query 'length(modelSummaries)' --output text >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/network.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/foundation.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/image.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/runtime.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/provisioning.yaml" >/dev/null
aws_cli cloudformation validate-template --template-body "file://$ROOT_DIR/templates/web.yaml" >/dev/null

say "Checking configured Bedrock model names"
CLAUDE_MODEL="$(config '.models.claude')"
CODEX_MODEL="$(config '.models.codex')"
CLAUDE_PROFILE="$(aws_cli bedrock get-inference-profile --inference-profile-identifier "$CLAUDE_MODEL" --output json)" || \
  fail "The configured Claude model must be an available Bedrock inference profile"
jq -e '.status == "ACTIVE" and (.inferenceProfileArn | length > 0) and (.models | length > 0)' <<<"$CLAUDE_PROFILE" >/dev/null || \
  fail "The configured Claude inference profile is not active or has no destination models"
aws_cli bedrock list-foundation-models --query "modelSummaries[?modelId=='$CODEX_MODEL'].modelId | [0]" --output text | grep -F "$CODEX_MODEL" >/dev/null || \
  say "Codex model is not returned by list-foundation-models; deploy will verify it with the live CLI test"

say "Doctor checks passed"
