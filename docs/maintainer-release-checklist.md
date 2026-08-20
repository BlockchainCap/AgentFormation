# Maintainer release checklist

Public pull-request checks intentionally do not receive AWS credentials. Before a
release that changes infrastructure, authentication, runtime images, or terminal
behavior, a maintainer should use a dedicated test AWS account and complete this
checklist.

- Run all local and CI checks from `CONTRIBUTING.md`.
- Confirm the configured Claude Code and Codex versions still exist at their
  official distribution sources.
- Deploy from a clean checkout with `./agentformation deploy`.
- Confirm the first build warning is accurate and record total deployment time.
- Sign in as a real invited Cognito user.
- Confirm the user starts in `/workspace`.
- Run `claude --version` and `codex --version`.
- Make one harmless Bedrock request through each CLI.
- Create a file, disconnect, reconnect, and confirm the `tmux` process and file
  persist.
- Upload a harmless file and confirm it lands under `/workspace/.uploads`.
- Create a second Cognito test identity with `--suppress-invite` and verify the
  first user's authenticated requests cannot select or access that runtime.
- Disable the test identity and confirm sign-in is blocked and EC2 is stopping.
- Purge the test identity and verify its stack and volume are gone.
- Review IAM Access Analyzer and ECR image scan findings.
- Run `./agentformation destroy --confirm DELETE` after the review window and
  verify no tagged EC2, EBS, NAT, App Runner, ECR, S3, DynamoDB, Cognito, Secrets
  Manager, Image Builder, AMI, or snapshot resources remain.

Do not paste account IDs, user emails, secrets, session tokens, terminal contents,
or private resource URLs into public release notes.
