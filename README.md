# AgentFormation

An AWS-native solution template for persistent remote coding agents.

AgentFormation gives each invited user a private EC2 workspace with both
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
[Codex](https://developers.openai.com/codex/) configured to use Amazon Bedrock.
A small web app provides authenticated browser terminals, persistent `tmux`
sessions, and file uploads. Everything deploys into an AWS account you control.

> [!IMPORTANT]
> The first deployment builds a complete runtime image and an App Runner service.
> It commonly takes more than 30 minutes. This is normal for the AWS services used
> by this template, not a frozen terminal.

## What it creates

```text
invited user -> Cognito sign-in -> App Runner web terminal
                                      |
                                      v
                               DynamoDB assignment
                                      |
                                      v
                           private EC2 runtime (one/user)
                             Claude Code + Codex + /workspace
                                      |
                                      v
                              Amazon Bedrock models
```

- Amazon Cognito with self-sign-up disabled
- one private VPC subnet and one NAT gateway by default
- one private, encrypted EC2 runtime and EBS volume per user
- AWS Systems Manager Session Manager instead of inbound SSH
- an EC2 Image Builder pipeline with pinned Claude Code and Codex versions
- an App Runner web terminal
- a DynamoDB identity-to-runtime registry
- a short-lived, encrypted S3 upload staging area

You do **not** need AWS Organizations, Google Workspace, or Google OAuth. You do
need an AWS account, an AWS CLI profile with permission to create the resources,
Docker with `buildx`, `jq`, and access to the selected Bedrock models.

If your organization requires CloudFormation to use an existing service role,
add its ARN as `cloudFormationRoleArn` in `agentformation.local.json`. The example
omits it because most personal AWS accounts do not need one.

## Quick start

1. Clone the repository and create a private local configuration:

   ```bash
   cp agentformation.example.json agentformation.local.json
   ```

2. Replace `admin@example.com`, review the instance size and Bedrock model IDs,
   then run:

   ```bash
   AWS_PROFILE=your-profile ./agentformation doctor
   AWS_PROFILE=your-profile ./agentformation deploy
   ```

3. Open the printed web address and use the temporary password from the Cognito
   invitation. Cognito asks you to choose a permanent password on first sign-in.

The deployment command is safe to run again. CloudFormation applies changes and
the user command keeps the same runtime stack for an existing Cognito identity.
It reuses the newest tested AMI from the current pipeline; set
`AGENTFORMATION_REBUILD_IMAGE=1` when you intentionally want a fresh runtime
image with otherwise unchanged settings.

## Daily administration

```bash
# Show shared stacks, users, runtimes, and the web address
AWS_PROFILE=your-profile ./agentformation status

# Invite a user and create one runtime
AWS_PROFILE=your-profile ./agentformation users add --email person@example.com

# Block sign-in and stop the runtime while preserving its disk
AWS_PROFILE=your-profile ./agentformation users disable --email person@example.com

# Re-enable the identity and restart its preserved runtime
AWS_PROFILE=your-profile ./agentformation users add --email person@example.com

# Permanently delete a user, runtime, and runtime disk
AWS_PROFILE=your-profile ./agentformation users purge \
  --email person@example.com --confirm DELETE

# Permanently delete the complete deployment
AWS_PROFILE=your-profile ./agentformation destroy --confirm DELETE
```

Users start in `/workspace`. They can create project folders directly underneath
it. Closing a browser does not kill the `tmux` session, so reconnecting returns to
the same terminal process.

## Security model

AgentFormation isolates ordinary app users from one another, but the AWS account
administrator remains trusted and can inspect or change all resources. The browser
cannot choose an instance ID; the server derives the signed-in Cognito subject and
looks up its assigned runtime. Runtimes have no public IP and no inbound security
group rules.

Read [the security model](docs/security-model.md) and
[the privacy notes](docs/privacy.md) before inviting users. To report a
vulnerability, follow [SECURITY.md](SECURITY.md).

## Cost and cleanup

This is not a free-tier-only template. The main always-on or usage-based costs are
App Runner, a NAT gateway, one EC2 instance and EBS volume per user, Image Builder,
S3, DynamoDB, and Bedrock requests. Check the
[AWS Pricing Calculator](https://calculator.aws/) for your region and sizes.
Disabling a user stops EC2 compute but preserves EBS storage. Use `purge` or
`destroy` when data is no longer needed.

## Development

```bash
cd web
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build

cd ..
shellcheck -x -P SCRIPTDIR scripts/*.sh scripts/lib/*.sh agentformation
cfn-lint templates/*.yaml
```

Pull requests run these checks without receiving AWS credentials. A full AWS
deployment is deliberately a maintainer-run release check because it creates
billable resources and requires account-specific Bedrock access.

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[maintainer release checklist](docs/maintainer-release-checklist.md).

## Support and license

AgentFormation is a community reference project. There is no guaranteed support
or uptime commitment. Bugs and improvements are welcome through GitHub issues and
pull requests.

Licensed under the [BSD 2-Clause License](LICENSE).
