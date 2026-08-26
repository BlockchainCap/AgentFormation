# Contributing

Thanks for helping improve AgentFormation.

## Before opening a change

- Open an issue first for large architecture or security changes.
- Never commit AWS credentials, account identifiers, private email addresses,
  IAM Identity Center metadata addresses or XML, terminal history, `.env` files,
  or `agentformation.local.json`.
- Keep the federated Cognito subject-to-runtime authorization on the server. The
  browser must never supply or select an EC2 instance ID.
- Preserve IAM Identity Center as the only employee sign-in. Do not add a local
  password, self-sign-up, app-specific MFA, or browser-selected provisioning
  parameters.
- Keep environment creation behind the fixed Step Functions job, content-hashed
  runtime template, conditional one-per-subject record, and restricted
  CloudFormation service role.
- Pin tool versions and GitHub Actions. Explain version upgrades in the pull
  request.
- Do not add an AWS deployment workflow that receives credentials from public pull
  requests.

## Checks

Use the Node.js and Bun versions pinned in `agentformation.example.json` for the
web app. New AgentFormation runtime images include those versions, so a checkout
under `/workspace` can run the same checks. From the repository root, the
complete check is:

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
AWS resources or costs affected. Authentication or provisioning changes must also
state how assigned and unassigned Identity Center users were tested. Keep
unrelated cleanup in a separate change.
