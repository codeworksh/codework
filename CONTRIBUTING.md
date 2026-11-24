# Contributing to CodeWork

Thanks for helping out. This guide is short so it saves time for you and for us.

## What We Welcome

Pull requests are welcome, and we're glad to see them. The ones we can merge quickly:

- Fix a bug you can reproduce.
- Solve a real problem you or other users have hit.
- Improve performance, docs or tests.

New features are welcome too, but please open an issue first. Every feature we merge is one we support for a long time, across every provider and every surface (the RPC server, the CLI and the desktop app). Talking it through first saves you building something we can't take on.

If a feature could be a plugin, it probably should be. The plugin contract in `packages/plugin` exists so CodeWork can grow without its core getting heavier.

## The One Rule

**Understand your code.** You should be able to explain what your change does and how it fits with the rest of the system.

Using AI to write code is fine, and CodeWork itself is a coding agent. Just review what it wrote before you send it. If you use an agent, run it from the repository root so it reads [AGENTS.md](AGENTS.md).

## Issues

Keep issues short and concrete:

- Say what happened and what you expected, or what you'd like to see.
- Explain why it matters.
- Include steps to reproduce a bug, your version (`codework --version`), and your platform.
- If you'd like to work on it yourself, say so.

## Before You Open a PR

1. Set up the repository with [00_development.md](docs/operations/00_development.md).
2. Run `vp run verify`. It's the check CI runs on every pull request.
3. Run the tests for the code you changed. CI doesn't run them, so this part is on you. [13_testing.md](docs/internals/13_testing.md) explains how.
4. Target the `canary` branch.

Please don't edit `CHANGELOG.md` or bump versions. The maintainers write release notes and cut releases.

## Questions

[Open an issue](https://github.com/codeworksh/codework/issues). We're happy to help.
