# @codeworksh/sdk

TypeScript SDK for the CodeWork API.

## Development

Generate the OpenAPI spec from the agent package, then regenerate the SDK:

```bash
pnpm --filter @codeworksh/agent openapi
pnpm --filter @codeworksh/sdk generate
```
