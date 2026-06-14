# AIKit OpenAI Codex Example

This example uses [`@codeworksh/aikit`](https://codeworksh.github.io/aikit/) with OpenAI Codex authentication.
For the fastest setup and runtime experience, use [Bun](https://bun.com).

## Quick Start

1. Install the dependencies:

   ```bash
   bun install
   ```

2. Generate the model catalog:

   ```bash
   bunx aikit modelgen
   ```

3. Authenticate with OpenAI Codex:

   ```bash
   bunx aikit auth --openai-codex
   ```

   Optionally, check the status of your stored credentials:

   ```bash
   bunx aikit auth --openai-codex --status
   ```

4. Run the example:

   ```bash
   bun run index.ts
   ```

## Learn More

Read the [AIKit documentation](https://codeworksh.github.io/aikit/) for API details, model configuration, and
additional examples.

For direct support or to share feedback, contact the developer on [X](https://x.com/_sanchitrk).

Useful feedback may qualify for $10 in OpenRouter credits.
