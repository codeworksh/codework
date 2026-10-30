

Daytona supports multiple methods to configure your environment, in order of precedence:

1. [Configuration in code](#configuration-in-code)
2. [Environment variables](#environment-variables)
3. [.env file](#env-file)
4. [Default values](#default-values)

## Configuration in code

To configure your environment in code, use the `DaytonaConfig` class. The `DaytonaConfig` class accepts the following parameters:

- `api_key`: Your Daytona [API Key](../../SKILL.md#authentication)
- `api_url`: URL of your [Daytona API](../api/README.md)
- `target`: Target region to create the Sandboxes on (`us` / `eu`)

```python
from daytona import DaytonaConfig

config = DaytonaConfig(
    api_key="YOUR_API_KEY",
    api_url="YOUR_API_URL",
    target="us"
)
```

## Environment variables

Daytona supports environment variables for configuration. The SDK automatically looks for these environment variables:

| Variable              | Description                                | Required |
| --------------------- | ------------------------------------------ | -------- |
| **`DAYTONA_API_KEY`** | Your Daytona API key.                      | Yes      |
| **`DAYTONA_API_URL`** | URL of your Daytona API.                   | No       |
| **`DAYTONA_TARGET`**  | Daytona Target to create the sandboxes on. | No       |

### Shell

Set environment variables in your shell using the following methods:

**Bash/Zsh:**

```bash
export DAYTONA_API_KEY=your-api-key
export DAYTONA_API_URL=https://your-api-url
export DAYTONA_TARGET=us
```

**Windows PowerShell:**

```bash
$env:DAYTONA_API_KEY="your-api-key"
$env:DAYTONA_API_URL="https://your-api-url"
$env:DAYTONA_TARGET="us"
```

### .env file

Set the environment variables in a `.env` file using the following format:

```bash
DAYTONA_API_KEY=YOUR_API_KEY
DAYTONA_API_URL=https://your_api_url
DAYTONA_TARGET=us
```

## Default values

If no configuration is provided, Daytona will use its built-in default values:

| **Option** | **Value**                           |
| ---------- | ----------------------------------- |
| API URL    | https://app.daytona.io/api          |
| Target     | Default region for the organization |
