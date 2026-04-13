# codemode-finance-csv

Node.js example for `@codeworksh/aikit` that uses `CodeMode` to analyze a local bank statement CSV.

The agent gets a typed `readStatementCsv` tool, and `CodeMode` exposes that tool inside sandboxed TypeScript as `external_readStatementCsv(...)`. The model can then write code against the tool's type definitions to answer arbitrary finance questions.

## What It Does

- Reads `src/data/statement.csv`
- Parses statement rows into typed records with `number | null` debits and credits
- Creates a `readStatementCsv` tool
- Wraps that tool with `CodeMode.create(...)`
- Runs an interactive shell where the model writes sandboxed TypeScript to answer user questions

## Setup

From the example directory:

```bash
cd packages/aikit/examples/codemode-finance-csv
pnpm install --ignore-workspace
```

Set these environment variables in `.env`:

```env
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
AIKIT_MODEL=claude-haiku-4-5-20251001
```

If your CSV lives somewhere else, set:

```env
STATEMENT_CSV_PATH=/absolute/path/to/statement.csv
```

By default the example looks for `src/data/statement.csv`.

## Run

```bash
pnpm dev
```

Then ask questions like:

```text
How much did I spend on Food in the last 90 days?
Which categories had the highest debit totals?
What was my largest credit transaction this year?
Show the top 5 merchants by debit spend.
```

Type `exit` or `quit` to stop the session.
