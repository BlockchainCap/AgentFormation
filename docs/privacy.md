# Privacy notes

AgentFormation is self-hosted in the operator's AWS account. The project itself
does not run a hosted service or receive deployment data.

The deployed system stores:

- invited users' email addresses and Cognito identifiers;
- the mapping between a user and an EC2 runtime;
- encrypted runtime files on EBS;
- uploaded files in S3 until copied or expired; and
- normal AWS service, access, build, and application logs.

Terminal traffic uses AWS Systems Manager. Prompts and code sent to Claude Code or
Codex are processed through Amazon Bedrock under the operator's AWS agreement and
configuration. Git providers, package registries, and any tools a user runs may
receive additional data.

Codex uses Bedrock's OpenAI-compatible Responses API. That API can store response
state when a client requests it. The pinned Codex release sends `store=false` for
the built-in Bedrock provider, but maintainers should recheck this behavior before
upgrading Codex. See the [Bedrock Responses API privacy notes](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html)
and the [Codex source](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs).

Operators are responsible for giving users appropriate notice, choosing AWS
regions and retention settings, controlling log access, responding to data
requests, and deleting users and resources when no longer needed. Do not use real
personal or confidential data in a test deployment unless your policies allow it.
