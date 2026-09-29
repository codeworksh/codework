# Vendored: effect-acp

Effect-native Agent Client Protocol (agent and client), copied from t3code. Private and bundled into
`packages/codework`; never published.

| | |
| --- | --- |
| Upstream | https://github.com/pingdotgg/t3code, `packages/effect-acp` |
| Branch | `t3code/acp-runtime-v1` (PR pingdotgg/t3code#13784, unmerged when copied) |
| Commit | `f56e8b3815` |
| ACP schemas | `schema-v1.21.0` (v1) and `schema-v2.0.0-alpha.3` (v2) |
| Effect | `4.0.0-rc.115` (upstream pins the same version) |
| License | MIT, © 2026 T3 Tools Inc., see `LICENSE` |
| Copied | 2026-09-29 |

## Local changes

- `package.json`: renamed to `@codeworksh/acp`, marked private, trimmed scripts and dependencies to what
  `src` and `scripts/generate.ts` need.
- `tsconfig.json`: extends this repo's root config and adds `lib: ["ES2025"]` for `RegExp.escape` in the generator.
- Left out the unit tests (`*.test.ts`) and `test/fixtures`; the `codework acp` E2E test covers this package.
- `src/agent.ts` is **ours**, not upstream's. Upstream's agent serves ACP v2 only (`session/resume`, `auth/login`,
  no `tool_call` update), which no editor speaks yet. Ours serves ACP v1 from `schema-v1.gen.ts` over the vendored
  transport (`protocol.ts`) and error mapping (`_internal/shared.ts`), and takes its handlers before the first
  message is read. The v1/v2-negotiating client (`client.ts`, `compat.ts`) is upstream's and drives it in the E2E test.

Everything else under `src/` and `scripts/` is byte-identical to upstream.

## Notes

- **Don't regenerate yet.** The upstream generator at this commit maps `unevaluatedProperties: true` to
  `Schema.StructWithRest`, but the committed `_generated/` files still contain plain `Schema.Struct`s,
  and `rpc.ts` depends on that (`.fields`). Regenerating breaks typecheck. Keep upstream's generated files
  until upstream reconciles the two.
- t3code patches `effect@4.0.0-rc.115` (RpcClient request hooks, ping/pong hooks). This package doesn't use
  those APIs, so it runs on stock Effect.

## Syncing

Copy `src/` and `scripts/` from a newer upstream commit, drop the tests, re-run `pnpm run typecheck`, and
update the commit and schema rows above.
