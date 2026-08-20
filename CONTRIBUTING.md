# Contributing

Thanks for helping improve AgentFormation.

## Before opening a change

- Open an issue first for large architecture or security changes.
- Never commit AWS credentials, account identifiers, private email addresses,
  terminal history, `.env` files, or `agentformation.local.json`.
- Keep Cognito subject-to-runtime authorization on the server. The browser must
  never supply or select an EC2 instance ID.
- Pin tool versions and GitHub Actions. Explain version upgrades in the pull
  request.
- Do not add an AWS deployment workflow that receives credentials from public pull
  requests.

## Checks

Use Bun 1.3.6 for the web app. From the repository root, the complete check is:

```bash
./scripts/check.sh
```

The equivalent individual commands are:

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

Tests should protect behavior with security or maintenance value. Small unit tests
and template validation belong in the repository. Account-specific, billable AWS
deployment tests stay in the maintainer checklist.

## Pull requests

Describe what changed, why, security and privacy effects, test evidence, and any
AWS resources or costs affected. Keep unrelated cleanup in a separate change.
