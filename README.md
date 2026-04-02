# CODEWORK

<p align="center" dir="auto">
  <a href="https://codework.sh" rel="nofollow">
    <img src="./assets/logo.svg" alt="CODEWORK logo" width="720" style="max-width: 100%;">
  </a>
</p>

Toolkit for building AI agents.

## Get Started

```bash
bun add @codeworksh/aikit
```

## Publishing

```bash
bun run publish:aikit:dry-run
bun run publish:aikit
```

For workspace publishing, the repo now includes `scripts/publish.ts`, which resolves the package directory and runs `bun publish` for `@codeworksh/*` packages such as `aikit` and `utils`.

## License

MIT
