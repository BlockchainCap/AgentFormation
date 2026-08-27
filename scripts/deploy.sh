#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

"$SCRIPT_DIR/doctor.sh"
ensure_state_dir

DEPLOYMENT="$(deployment_name)"
ACCOUNT_ID="$(aws_cli sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws_cli sts get-caller-identity --query Arn --output text)"
AWS_PARTITION="$(cut -d: -f2 <<<"$CALLER_ARN")"
DOMAIN_SUFFIX="$(hash_text "$ACCOUNT_ID:$DEPLOYMENT" | cut -c1-10)"
DOMAIN_PREFIX="$DEPLOYMENT-$DOMAIN_SUFFIX"
IDENTITY_CENTER_METADATA_URL="$(config '.identityCenter.metadataUrl // ""')"
IDENTITY_CENTER_METADATA_FILE="$(config '.identityCenter.metadataFile // ""')"
CONFIGURED_PUBLIC_URL="$(config '(.publicUrl // "") | rtrimstr("/")')"

if [[ -n "$CONFIGURED_PUBLIC_URL" ]]; then
  require_https_origin "publicUrl" "$CONFIGURED_PUBLIC_URL"
fi
if [[ -n "$IDENTITY_CENTER_METADATA_FILE" && "$IDENTITY_CENTER_METADATA_FILE" != /* ]]; then
  IDENTITY_CENTER_METADATA_FILE="$ROOT_DIR/$IDENTITY_CENTER_METADATA_FILE"
fi

CONFIGURE_CASE_INSENSITIVE_USERNAMES=true
FOUNDATION_EXISTS=false
if stack_exists "$(foundation_stack)"; then
  FOUNDATION_EXISTS=true
  EXISTING_USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
  EXISTING_USERNAME_CASE_SENSITIVE="$(aws_cli cognito-idp describe-user-pool \
    --user-pool-id "$EXISTING_USER_POOL_ID" \
    --query 'UserPool.UsernameConfiguration.CaseSensitive' \
    --output text)"
  case "$EXISTING_USERNAME_CASE_SENSITIVE" in
    False | false)
      CONFIGURE_CASE_INSENSITIVE_USERNAMES=true
      ;;
    True | true | None | none | null | '')
      # Older pools can omit this immutable property; Cognito then keeps its
      # original case-sensitive default. Preserve it during an upgrade.
      CONFIGURE_CASE_INSENSITIVE_USERNAMES=false
      ;;
    *)
      fail "Could not determine the existing Cognito username case-sensitivity setting"
      ;;
    esac
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || exit "$stack_status"
fi

print_identity_center_setup() {
  local acs_url audience user_pool_id outputs cognito_domain_suffix
  outputs="$(aws_cli cloudformation describe-stacks \
    --stack-name "$(foundation_stack)" \
    --query 'Stacks[0].Outputs' \
    --output json)"
  acs_url="$(jq -r '[.[] | select(.OutputKey == "CognitoSamlAcsUrl") | .OutputValue][0] // ""' <<<"$outputs")"
  audience="$(jq -r '[.[] | select(.OutputKey == "CognitoSamlAudience") | .OutputValue][0] // ""' <<<"$outputs")"
  if [[ ! "$acs_url" =~ ^https:// ]] || [[ "$audience" != urn:amazon:cognito:sp:* ]]; then
    user_pool_id="$(jq -r '[.[] | select(.OutputKey == "UserPoolId") | .OutputValue][0] // ""' <<<"$outputs")"
    [[ -n "$user_pool_id" ]] || fail "The foundation stack did not return the Cognito user pool ID"
    if [[ "$AWS_PARTITION" == "aws-cn" ]]; then
      cognito_domain_suffix="amazoncognito.com.cn"
    else
      cognito_domain_suffix="amazoncognito.com"
    fi
    acs_url="https://$DOMAIN_PREFIX.auth.$(region).$cognito_domain_suffix/saml2/idpresponse"
    audience="urn:amazon:cognito:sp:$user_pool_id"
  fi
  say "SAML ACS URL: $acs_url"
  say "SAML audience: $audience"
}

if [[ -z "$IDENTITY_CENTER_METADATA_URL" && -z "$IDENTITY_CENTER_METADATA_FILE" && "$FOUNDATION_EXISTS" == "true" ]]; then
  say "Identity Center setup is required before this existing deployment can be updated"
  print_identity_center_setup
  fail "Assign an IAM Identity Center group to a custom SAML application, then set identityCenter.metadataUrl (preferred) or identityCenter.metadataFile"
fi

deploy_stack "$(network_stack)" templates/network.yaml \
  DeploymentName="$DEPLOYMENT" \
  NetworkMode="$(config '.networkMode')"

INITIAL_PUBLIC_URL="$CONFIGURED_PUBLIC_URL"
if [[ -z "$INITIAL_PUBLIC_URL" ]]; then
  if stack_exists "$(web_stack)"; then
    INITIAL_PUBLIC_URL="$(stack_output "$(web_stack)" ServiceUrl)"
    require_https_origin "The existing web service URL" "$INITIAL_PUBLIC_URL"
  else
    stack_status=$?
    [[ "$stack_status" -eq 1 ]] || exit "$stack_status"
    # A localhost callback exists only long enough to bootstrap a genuinely new
    # deployment. Read failures on an existing web stack must stop the deploy.
    INITIAL_PUBLIC_URL="https://localhost"
  fi
fi

deploy_foundation_stack() {
  local configure_identity_center="$1"
  local public_url="$2"
  deploy_stack "$(foundation_stack)" templates/foundation.yaml \
    DeploymentName="$DEPLOYMENT" \
    CognitoDomainPrefix="$DOMAIN_PREFIX" \
    ConfigureCaseInsensitiveUsernames="$CONFIGURE_CASE_INSENSITIVE_USERNAMES" \
    ConfigureIdentityCenterClient="$configure_identity_center" \
    InitialCallbackUrl="$public_url/api/auth/callback/cognito" \
    InitialLogoutUrl="$public_url/" \
    UploadAllowedOrigin="$public_url"
}

if [[ "$FOUNDATION_EXISTS" == "false" ]]; then
  # The user pool must exist before IAM Identity Center can be configured. The
  # bootstrap stack has no app client, so local Cognito login is never exposed.
  deploy_foundation_stack false "$INITIAL_PUBLIC_URL"
fi

if [[ -z "$IDENTITY_CENTER_METADATA_URL" && -z "$IDENTITY_CENTER_METADATA_FILE" ]]; then
  say "The identity bootstrap is ready"
  print_identity_center_setup
  say "Next: create and assign the IAM Identity Center SAML application, set identityCenter.metadataUrl (preferred) or identityCenter.metadataFile, and run deploy again"
  exit 0
fi

USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"

say "Connecting the Cognito bridge to IAM Identity Center"
if [[ -n "$IDENTITY_CENTER_METADATA_URL" ]]; then
  IDENTITY_CENTER_PROVIDER_DETAILS="$(jq -cn \
    --arg metadataUrl "$IDENTITY_CENTER_METADATA_URL" \
    '{MetadataURL:$metadataUrl,IDPInit:"false",IDPSignout:"false",RequestSigningAlgorithm:"rsa-sha256"}')"
else
  IDENTITY_CENTER_PROVIDER_DETAILS="$(jq -cn \
    --rawfile metadata "$IDENTITY_CENTER_METADATA_FILE" \
    '{MetadataFile:$metadata,IDPInit:"false",IDPSignout:"false",RequestSigningAlgorithm:"rsa-sha256"}')"
fi
if aws_cli cognito-idp describe-identity-provider \
  --user-pool-id "$USER_POOL_ID" \
  --provider-name IdentityCenter >/dev/null 2>&1; then
  aws_cli cognito-idp update-identity-provider \
    --user-pool-id "$USER_POOL_ID" \
    --provider-name IdentityCenter \
    --provider-details "$IDENTITY_CENTER_PROVIDER_DETAILS" \
    --attribute-mapping email=email \
    --idp-identifiers identity-center >/dev/null
else
  aws_cli cognito-idp create-identity-provider \
    --user-pool-id "$USER_POOL_ID" \
    --provider-name IdentityCenter \
    --provider-type SAML \
    --provider-details "$IDENTITY_CENTER_PROVIDER_DETAILS" \
    --attribute-mapping email=email \
    --idp-identifiers identity-center >/dev/null
fi

deploy_foundation_stack true "$INITIAL_PUBLIC_URL"
CLIENT_ID="$(stack_output "$(foundation_stack)" UserPoolClientId)"
CLIENT_SECRET_ARN="$(stack_output "$(foundation_stack)" CognitoClientSecretArn)"
AUTH_SECRET_ARN="$(stack_output "$(foundation_stack)" AuthSecretArn)"
USER_REGISTRY_TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
CONTROL_TABLE_NAME="$(stack_output "$(foundation_stack)" ControlTableName)"
UPLOAD_BUCKET="$(stack_output "$(foundation_stack)" UploadBucketName)"
TERMINAL_SESSION_DOCUMENT_NAME="$(stack_output "$(foundation_stack)" TerminalSessionDocumentName)"
UPLOAD_DELIVERY_DOCUMENT_NAME="$(stack_output "$(foundation_stack)" UploadDeliveryDocumentName)"
OAUTH_RELAY_DOCUMENT_NAME="$(stack_output "$(foundation_stack)" OAuthRelayDocumentName)"

say "Storing the generated Cognito client secret without printing it"
aws_cli cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' \
  --output text | \
  aws_cli secretsmanager put-secret-value \
    --secret-id "$CLIENT_SECRET_ARN" \
    --secret-string file:///dev/stdin >/dev/null

ARCHITECTURE="$(config '.runtime.architecture')"
AWS_CLI_VERSION="$(config '.versions.awsCli')"
NODE_VERSION="$(config '.versions.node')"
BUN_VERSION="$(config '.versions.bun')"
CLAUDE_CODE_VERSION="$(config '.versions.claudeCode')"
CODEX_VERSION="$(config '.versions.codex')"
IMAGE_TEMPLATE_HASH="$(hash_text "$(<"$ROOT_DIR/templates/image.yaml")")"
IMAGE_COMPONENT_HASH="$(hash_text "$ARCHITECTURE:$AWS_CLI_VERSION:$NODE_VERSION:$BUN_VERSION:$CLAUDE_CODE_VERSION:$CODEX_VERSION:$IMAGE_TEMPLATE_HASH")"
IMAGE_COMPONENT_VERSION="1.0.$((16#${IMAGE_COMPONENT_HASH:0:7}))"
if [[ "$ARCHITECTURE" == "arm64" ]]; then
  BUILD_INSTANCE="c7g.large"
else
  BUILD_INSTANCE="c7i.large"
fi

deploy_stack "$(image_stack)" templates/image.yaml \
  DeploymentName="$DEPLOYMENT" \
  NetworkStackName="$(network_stack)" \
  Architecture="$ARCHITECTURE" \
  BuildInstanceType="$BUILD_INSTANCE" \
  AwsCliVersion="$AWS_CLI_VERSION" \
  NodeVersion="$NODE_VERSION" \
  BunVersion="$BUN_VERSION" \
  ClaudeCodeVersion="$CLAUDE_CODE_VERSION" \
  CodexVersion="$CODEX_VERSION" \
  AmiParameterPath="$(ami_parameter_path)" \
  ComponentVersion="$IMAGE_COMPONENT_VERSION"

PIPELINE_ARN="$(stack_output "$(image_stack)" ImagePipelineArn)"
IMAGE_ARN=""
if [[ "${AGENTFORMATION_REBUILD_IMAGE:-0}" != "1" ]]; then
  IMAGE_ARN="$(aws_cli imagebuilder list-image-pipeline-images \
    --image-pipeline-arn "$PIPELINE_ARN" \
    --query "reverse(sort_by(imageSummaryList[?state.status==\`AVAILABLE\`],&dateCreated))[0].arn" \
    --output text)"
  [[ "$IMAGE_ARN" == "None" ]] && IMAGE_ARN=""
fi

if [[ -z "$IMAGE_ARN" ]]; then
  say "Starting the AMI build; this commonly takes 15–30 minutes"
  IMAGE_ARN="$(aws_cli imagebuilder start-image-pipeline-execution \
    --image-pipeline-arn "$PIPELINE_ARN" \
    --query imageBuildVersionArn \
    --output text)"

  while true; do
    IMAGE_STATUS="$(aws_cli imagebuilder get-image \
      --image-build-version-arn "$IMAGE_ARN" \
      --query 'image.state.status' \
      --output text)"
    say "Image Builder status: $IMAGE_STATUS"
    case "$IMAGE_STATUS" in
      AVAILABLE) break ;;
      FAILED|CANCELLED|DELETED)
        aws_cli imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" --query 'image.state.reason' --output text >&2
        fail "AMI build did not complete"
        ;;
    esac
    sleep 30
  done
else
  say "Reusing the latest tested AMI from the current image pipeline"
fi

BUILT_IMAGE="$(aws_cli imagebuilder get-image \
  --image-build-version-arn "$IMAGE_ARN" \
  --output json)"
jq -e --arg region "$(region)" --arg account "$ACCOUNT_ID" '
  (.image.outputResources.amis | type == "array" and length > 0) and
  all(.image.outputResources.amis[];
    .region == $region and .accountId == $account and
    (.image | test("^ami-([0-9a-f]{8}|[0-9a-f]{17})$")))
' <<<"$BUILT_IMAGE" >/dev/null || fail "Image Builder returned an AMI outside this AWS account and region"
AMI_ID="$(jq -er --arg region "$(region)" '
  [.image.outputResources.amis[] | select(.region == $region) | .image] | first
' <<<"$BUILT_IMAGE")"
[[ "$AMI_ID" =~ ^ami-([0-9a-f]{8}|[0-9a-f]{17})$ ]] || fail "Image Builder did not return an AMI ID"
AMI_DESCRIPTION="$(aws_cli ec2 describe-images --image-ids "$AMI_ID" --output json)"
AMI_SNAPSHOT_ID_LINES="$(jq -er '[.Images[]?.BlockDeviceMappings[]?.Ebs.SnapshotId] | unique | join("\n")' \
  <<<"$AMI_DESCRIPTION")"
while IFS= read -r snapshot_id; do
  [[ -n "$snapshot_id" ]] || continue
  [[ "$snapshot_id" =~ ^snap-([0-9a-f]{8}|[0-9a-f]{17})$ ]] || \
    fail "The built AMI returned an invalid snapshot ID"
done <<<"$AMI_SNAPSHOT_ID_LINES"

tag_image_resource() {
  local resource_id="$1"
  local attempt=1 tag_result tag_error
  while [[ "$attempt" -le 30 ]]; do
    if tag_error="$(aws_cli ec2 create-tags \
      --resources "$resource_id" \
      --tags "Key=AgentFormationDeployment,Value=$DEPLOYMENT" 2>&1)"; then
      if tag_result="$(aws_cli ec2 describe-tags \
        --filters \
          "Name=resource-id,Values=$resource_id" \
          "Name=key,Values=AgentFormationDeployment" \
        --output json 2>&1)" && \
        jq -e --arg resource "$resource_id" --arg deployment "$DEPLOYMENT" '
          any(.Tags[]?;
            .ResourceId == $resource and
            .Key == "AgentFormationDeployment" and
            .Value == $deployment)
        ' <<<"$tag_result" >/dev/null; then
        return 0
      fi
    fi
    [[ "$attempt" -lt 30 ]] || {
      printf '%s\n' "${tag_error:-${tag_result:-EC2 did not confirm the resource tag}}" >&2
      fail "The built AMI or snapshot could not be tagged for teardown"
    }
    sleep 2
    attempt=$((attempt + 1))
  done
}

say "Tagging the built AMI and snapshots for complete teardown"
tag_image_resource "$AMI_ID"
while IFS= read -r snapshot_id; do
  [[ -n "$snapshot_id" ]] || continue
  tag_image_resource "$snapshot_id"
done <<<"$AMI_SNAPSHOT_ID_LINES"
aws_cli ssm put-parameter \
  --name "$(ami_parameter_path)" \
  --type String \
  --value "$AMI_ID" \
  --overwrite >/dev/null

RUNTIME_TEMPLATE_HASH="$(hash_text "$(<"$ROOT_DIR/templates/runtime.yaml")")"
RUNTIME_TEMPLATE_KEY="provisioning/runtime-$RUNTIME_TEMPLATE_HASH.yaml"
say "Publishing the reviewed runtime template under its content hash"
aws_cli s3api put-object \
  --bucket "$UPLOAD_BUCKET" \
  --key "$RUNTIME_TEMPLATE_KEY" \
  --body "$ROOT_DIR/templates/runtime.yaml" \
  --server-side-encryption AES256 \
  --tagging 'agentformation-lifecycle=current' \
  --expected-bucket-owner "$ACCOUNT_ID" >/dev/null

CLAUDE_MODEL="$(config '.models.claude')"
CLAUDE_PROFILE="$(aws_cli bedrock get-inference-profile \
  --inference-profile-identifier "$CLAUDE_MODEL" \
  --output json)" || fail "The configured Claude inference profile is unavailable"
CLAUDE_PROFILE_ARN="$(jq -er '.inferenceProfileArn' <<<"$CLAUDE_PROFILE")"
CLAUDE_MODEL_ARNS="$(jq -er '[.models[].modelArn] | select(length > 0) | join(",")' <<<"$CLAUDE_PROFILE")"
RUNTIME_SUBNET_ID="$(stack_output "$(network_stack)" PrivateSubnetId)"
RUNTIME_SECURITY_GROUP_ID="$(stack_output "$(network_stack)" RuntimeSecurityGroupId)"

deploy_stack "$(provisioning_stack)" templates/provisioning.yaml \
  DeploymentName="$DEPLOYMENT" \
  UserPoolId="$USER_POOL_ID" \
  UserRegistryTableName="$USER_REGISTRY_TABLE_NAME" \
  RuntimeTemplateBucket="$UPLOAD_BUCKET" \
  RuntimeTemplateKey="$RUNTIME_TEMPLATE_KEY" \
  RuntimeSubnetId="$RUNTIME_SUBNET_ID" \
  RuntimeSecurityGroupId="$RUNTIME_SECURITY_GROUP_ID" \
  RuntimeAmiId="$AMI_ID" \
  InstanceType="$(config '.runtime.instanceType')" \
  Architecture="$ARCHITECTURE" \
  VolumeSizeGiB="$(config '.runtime.volumeSizeGiB')" \
  ClaudeModelId="$CLAUDE_MODEL" \
  ClaudeInferenceProfileArn="$CLAUDE_PROFILE_ARN" \
  ClaudeFoundationModelArns="$CLAUDE_MODEL_ARNS" \
  CodexModelId="$(config '.models.codex')" \
  UploadBucketName="$UPLOAD_BUCKET"
PROVISIONING_STATE_MACHINE_ARN="$(stack_output "$(provisioning_stack)" StateMachineArn)"

retire_superseded_runtime_templates() {
  local provisioning_template_keys parsed_template_keys template_key template_tags
  say "Retiring superseded runtime templates without touching the live template"
  if ! provisioning_template_keys="$(aws_cli s3api list-objects-v2 \
    --bucket "$UPLOAD_BUCKET" \
    --prefix provisioning/ \
    --expected-bucket-owner "$ACCOUNT_ID" \
    --query 'Contents[].Key' \
    --output json)"; then
    printf 'WARNING: Superseded runtime templates could not be listed; deployment remains ready.\n' >&2
    return 0
  fi
  if ! parsed_template_keys="$(jq -er '(. // []) | map(select(type == "string")) | join("\n")' \
    <<<"$provisioning_template_keys")"; then
    printf 'WARNING: Superseded runtime template results could not be read; deployment remains ready.\n' >&2
    return 0
  fi

  while IFS= read -r template_key; do
    [[ -n "$template_key" ]] || continue
    if [[ ! "$template_key" =~ ^provisioning/runtime-[0-9a-f]{64}\.yaml$ ]]; then
      printf 'WARNING: Skipping an unexpected object under the provisioning prefix.\n' >&2
      continue
    fi
    [[ "$template_key" == "$RUNTIME_TEMPLATE_KEY" ]] && continue
    if ! template_tags="$(aws_cli s3api get-object-tagging \
      --bucket "$UPLOAD_BUCKET" \
      --key "$template_key" \
      --expected-bucket-owner "$ACCOUNT_ID" \
      --query TagSet \
      --output json)"; then
      printf 'WARNING: A superseded runtime template could not be inspected; continuing.\n' >&2
      continue
    fi
    if jq -e 'any(.[]; .Key == "agentformation-lifecycle" and .Value == "superseded")' \
      <<<"$template_tags" >/dev/null; then
      continue
    fi
    # The self-copy applies the retirement tag, resets its expiry window, and
    # deliberately replaces irrelevant object metadata on this YAML object.
    if ! aws_cli s3api copy-object \
      --bucket "$UPLOAD_BUCKET" \
      --key "$template_key" \
      --copy-source "$UPLOAD_BUCKET/$template_key" \
      --metadata-directive REPLACE \
      --tagging-directive REPLACE \
      --tagging 'agentformation-lifecycle=superseded' \
      --server-side-encryption AES256 \
      --expected-bucket-owner "$ACCOUNT_ID" \
      --expected-source-bucket-owner "$ACCOUNT_ID" >/dev/null; then
      printf 'WARNING: A superseded runtime template could not be retired; continuing.\n' >&2
    fi
  done <<<"$parsed_template_keys"
}

REPOSITORY_URI="$(stack_output "$(foundation_stack)" WebRepositoryUri)"
REPOSITORY_NAME="$(stack_output "$(foundation_stack)" WebRepositoryName)"
if [[ "$AWS_PARTITION" == "aws-cn" ]]; then
  ECR_URL_SUFFIX="amazonaws.com.cn"
else
  ECR_URL_SUFFIX="amazonaws.com"
fi
EXPECTED_REPOSITORY_URI="$ACCOUNT_ID.dkr.ecr.$(region).$ECR_URL_SUFFIX/$REPOSITORY_NAME"
[[ "$REPOSITORY_URI" == "$EXPECTED_REPOSITORY_URI" ]] || \
  fail "The foundation stack returned a web repository outside this account or region"
IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
REGISTRY_HOST="${REPOSITORY_URI%%/*}"
DOCKER_CONFIG_DIR="$STATE_DIR/docker"
DOCKER_AUTH_FILE="$DOCKER_CONFIG_DIR/config.json"
BUILDER_NAME="${DEPLOYMENT}-builder"
DOCKER_ENDPOINT="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
install -d -m 0700 "$DOCKER_CONFIG_DIR"
BUILDX_PLUGIN="$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "buildx"}}{{.Path}}{{end}}{{end}}')"
if [[ -n "$BUILDX_PLUGIN" ]]; then
  install -d -m 0700 "$DOCKER_CONFIG_DIR/cli-plugins"
  ln -sfn "$BUILDX_PLUGIN" "$DOCKER_CONFIG_DIR/cli-plugins/docker-buildx"
fi
say "Building and pushing the App Runner image"
ECR_PASSWORD="$(aws_cli ecr get-login-password)"
ECR_AUTH="$(printf 'AWS:%s' "$ECR_PASSWORD" | base64 | tr -d '\n')"
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REGISTRY_HOST" "$ECR_AUTH" >"$DOCKER_AUTH_FILE"
chmod 0600 "$DOCKER_AUTH_FILE"
unset ECR_PASSWORD ECR_AUTH
cleanup_docker_auth() {
  printf '{"auths":{}}\n' >"$DOCKER_AUTH_FILE"
  chmod 0600 "$DOCKER_AUTH_FILE"
}
trap cleanup_docker_auth EXIT

if ! DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx rm "$BUILDER_NAME" >/dev/null 2>&1 || true
  DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx create \
    --name "$BUILDER_NAME" \
    --driver docker-container >/dev/null
fi
DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx inspect "$BUILDER_NAME" --bootstrap >/dev/null
DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx build \
  --builder "$BUILDER_NAME" \
  --platform linux/amd64 \
  --progress plain \
  --provenance=true \
  --sbom=true \
  --push \
  --tag "$REPOSITORY_URI:${IMAGE_TAG}-attested" \
  "$ROOT_DIR/web"

# App Runner expects a conventional single-platform image tag. Publish the same
# cached layers in Docker v2 format while retaining the attested OCI tag above.
DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx build \
  --builder "$BUILDER_NAME" \
  --platform linux/amd64 \
  --progress plain \
  --provenance=false \
  --sbom=false \
  --output "type=image,name=$REPOSITORY_URI:$IMAGE_TAG,push=true,oci-mediatypes=false" \
  "$ROOT_DIR/web"
cleanup_docker_auth
trap - EXIT

WEB_IMAGE_DIGEST="$(aws_cli ecr describe-images \
  --repository-name "$REPOSITORY_NAME" \
  --image-ids "imageTag=$IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
[[ "$WEB_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || \
  fail "ECR did not return a valid digest for the web image"
WEB_IMAGE_IDENTIFIER="$REPOSITORY_URI@$WEB_IMAGE_DIGEST"

deploy_web_stack() {
  local public_url="$1"
  deploy_stack "$(web_stack)" templates/web.yaml \
    DeploymentName="$DEPLOYMENT" \
    ImageIdentifier="$WEB_IMAGE_IDENTIFIER" \
    PublicUrl="$public_url" \
    UserPoolClientId="$CLIENT_ID" \
    UserPoolId="$USER_POOL_ID" \
    CognitoClientSecretArn="$CLIENT_SECRET_ARN" \
    AuthSecretArn="$AUTH_SECRET_ARN" \
    UserRegistryTableName="$USER_REGISTRY_TABLE_NAME" \
    ControlTableName="$CONTROL_TABLE_NAME" \
    UploadBucketName="$UPLOAD_BUCKET" \
    TerminalSessionDocumentName="$TERMINAL_SESSION_DOCUMENT_NAME" \
    UploadDeliveryDocumentName="$UPLOAD_DELIVERY_DOCUMENT_NAME" \
    OAuthRelayDocumentName="$OAUTH_RELAY_DOCUMENT_NAME" \
    ProvisioningStateMachineArn="$PROVISIONING_STATE_MACHINE_ARN"
}

deploy_web_stack "$INITIAL_PUBLIC_URL"

SERVICE_URL="$(stack_output "$(web_stack)" ServiceUrl)"
require_https_origin "The deployed web service URL" "$SERVICE_URL"
PUBLIC_URL="${CONFIGURED_PUBLIC_URL:-$SERVICE_URL}"
require_https_origin "The final public URL" "$PUBLIC_URL"
if [[ "$INITIAL_PUBLIC_URL" != "$PUBLIC_URL" ]]; then
  say "Applying the final public address to Auth.js"
  deploy_web_stack "$PUBLIC_URL"
fi
say "Updating Cognito callback URLs for the public web address"
deploy_foundation_stack true "$PUBLIC_URL"

cat >"$STATE_DIR/deployment.json" <<STATE
{"deploymentName":"$DEPLOYMENT","region":"$(region)","serviceUrl":"$PUBLIC_URL","appRunnerServiceUrl":"$SERVICE_URL","imageBuildVersionArn":"$IMAGE_ARN"}
STATE
chmod 0600 "$STATE_DIR/deployment.json"

retire_superseded_runtime_templates
say "AgentFormation deployment is ready: $PUBLIC_URL"
