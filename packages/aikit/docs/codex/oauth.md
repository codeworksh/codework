# OpenAI Codex OAuth

_Coming soon._

AiKit ships with a CLI tool for managing local metadata and authentication, including OAuth flows for providers like OpenAI Codex.

## Managing Credentials

In the future, you will be able to manage OAuth credentials directly from your terminal:

```bash
# Start an OAuth login flow in your browser
pnpm aikit auth --openai-codex

# Check the status of your stored credentials
pnpm aikit auth --openai-codex --status

# Refresh your current credentials
pnpm aikit auth --openai-codex --refresh

# Clear stored credentials
pnpm aikit auth --openai-codex --logout
```
