# Command Line Interface (CLI)

AiKit ships with a built-in CLI available as `aikit`.

## Model Generation (`modelgen`)

The `modelgen` command is used to fetch and generate the `models.gen.json` metadata file that powers AiKit's model catalog. It connects to the configured model registry and downloads the latest specifications, cost data, and capabilities for all supported models.

### Usage

```bash
npx aikit modelgen [path]
```

**Arguments:**

- `path`: (Optional) The output path for the generated JSON file. If omitted, it defaults to the `CODEWORK_MODELS_FILE` environment variable or `./models.gen.json` in the current directory.

### Example

```bash
$ npx aikit modelgen src/models.gen.json
Generated model catalog at /path/to/project/src/models.gen.json
```

**Note:** If you are running your application in a different directory structure, you might need to ensure `models.gen.json` is located in the root of your project or specify the exact location via `CODEWORK_MODELS_FILE` during runtime so AiKit can discover it.
