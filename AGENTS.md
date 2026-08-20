# AgentFormation contributor guidance

AgentFormation is a community reference project for deploying private, persistent coding-agent runtimes on AWS.

## Boundaries

- Never commit real email addresses, AWS account IDs, credentials, generated passwords, deployment state, or environment-specific resource names.
- `agentformation.local.json`, `.env*`, and `.agentformation/` are local-only.
- Cognito subjects, not browser-supplied instance IDs or email strings, are the authorization boundary.
- An AWS account administrator is trusted. The application isolates invited users from each other; it cannot isolate resources from the administrator who owns the AWS account.
- Keep GitHub Actions validation-only. Do not add an AWS deployment workflow or static AWS credentials.

## Commands

Run web commands from `web/`:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Run repository checks from the root:

```bash
./agentformation doctor
./scripts/check.sh
```

## Code quality

- Prefer deleting special cases to adding branches.
- Keep AWS clients and authorization at server boundaries.
- Keep React components focused; extract stateful transport logic into hooks and pure parsing into utilities.
- Do not introduce files over 1,000 lines. Treat files over 500 lines as candidates for decomposition.
- Surface real deployment failures without returning raw AWS errors to browsers.
