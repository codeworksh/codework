# Gemini Example with AIKit

This is an example of how to use Google's Gemini models with the `@codeworksh/aikit` package.

## Setup

1. Make sure you have the `GOOGLE_GENERATIVE_AI_API_KEY` environment variable set.
   ```bash
   export GOOGLE_GENERATIVE_AI_API_KEY="your-api-key-here"
   ```

2. Run the example.
   ```bash
   # From this directory
   CODEWORK_MODELS_FILE="../../models.gen.json" pnpm start
   ```

## Notes
- We use the `google` provider with `gemini-2.5-flash` model.
- `CODEWORK_MODELS_FILE` points to the generated model catalog located in the root directory.
