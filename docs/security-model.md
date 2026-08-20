# Security model

## Trust boundaries

AgentFormation has two different administrator levels:

- An invited app user is trusted only inside that user's assigned runtime.
- The AWS account administrator is fully trusted. AWS administrators can use IAM,
  Systems Manager, EC2, snapshots, logs, or CloudFormation to access or modify any
  runtime.

AgentFormation does not claim to protect runtime data from the AWS account owner.

## User isolation

Self-sign-up is disabled. An administrator creates a Cognito user and a dedicated
runtime. DynamoDB stores the Cognito `sub`, email address, runtime stack, instance
ID, status, and update time.

For every terminal or upload request, the server:

1. verifies the Auth.js session;
2. reads the Cognito subject from that session;
3. retrieves the matching DynamoDB record;
4. requires the record to be active; and
5. targets only the instance in that record.

The client never submits an instance ID. Runtime IDs are not returned by the
session-start API. Browser termination requests also carry an HMAC proof binding
the Systems Manager session ID to the Cognito subject.

The App Runner role can reach all AgentFormation-tagged runtimes, so a compromise
of the web service role or server application can affect every managed runtime in
that deployment. Keep dependencies current and restrict who can change the web
image and CloudFormation stacks.

## Network and host controls

- Runtime instances are in a private subnet with no public IPv4 address.
- Their security group has no inbound rules.
- Browser terminals use AWS Systems Manager Session Manager; SSH is not opened.
- EC2 instance metadata requires IMDSv2.
- Runtime EBS volumes and staged uploads are encrypted at rest.
- Upload objects expire after one day and are deleted after they reach a runtime.
- The default network uses one NAT gateway. Optional AWS service endpoints reduce
  some traffic through that gateway but do not remove the need for internet access
  to Git hosts, package registries, and similar developer services.

## Credentials and model access

The runtime uses its EC2 instance role. Long-lived AWS access keys are not placed
on disk by the template. Claude Code and Codex use the normal AWS credential chain
and are configured for Amazon Bedrock.

Claude Code uses Bedrock's native runtime endpoint. Its runtime role allows
foundation-model invocation plus account inference profiles because cross-region
profiles can route to more than one underlying model ARN. Organizations that
require a strict Claude allowlist should narrow these resources to their approved
model and profile ARNs.

Codex uses Bedrock's OpenAI-compatible Mantle endpoint. Its inference permission
is restricted to the configured Codex model and the account's `default` Bedrock
project. The role can request first-use model enablement only when the call comes
through `bedrock-mantle.amazonaws.com`; it cannot call AWS Marketplace directly.
These permissions follow AWS's Mantle inference policy pattern while avoiding the
broader AWS-managed policy.

Bedrock access, provider terms, quotas, and regional model availability are
controlled separately by AWS.

## User lifecycle

- `users add` creates or reuses a Cognito identity, deploys one runtime, then writes
  the active assignment.
- `users disable` blocks Cognito sign-in first, marks the assignment disabled, and
  stops EC2 while preserving the encrypted disk.
- `users purge --confirm DELETE` removes the identity, CloudFormation runtime, and
  persistent disk.

An already-issued terminal session may remain usable briefly after a user is
disabled. Terminate active Systems Manager sessions if immediate eviction is
required.

## Known limits

- This is a reference project, not a formally audited security product.
- The web terminal depends on an npm package that implements the Session Manager
  browser protocol. Review dependency changes carefully.
- No backup or disaster-recovery policy is created for runtime EBS volumes.
- A single availability zone and NAT gateway keep the template understandable but
  are not a high-availability design.
