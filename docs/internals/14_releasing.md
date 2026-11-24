# Releasing

Every release is made by CI from one workflow, [publish.yml](../../.github/workflows/publish.yml). It publishes the npm packages, builds the standalone CLI binary, packages the desktop app, and makes the GitHub Releases. Locally a maintainer only bumps versions and pushes. One workflow file does all of it because npm trusted publishing names a single workflow.

## Channels

| Channel | Trigger                            | Version                                   |
| ------- | ---------------------------------- | ----------------------------------------- |
| canary  | every push to `canary`             | `<version>-canary.<run>.<attempt>.g<sha>` |
| dev     | every push to `dev`                | `<version>-dev.<YYYYMMDDHHMMSS>` (UTC)    |
| latest  | the workflow run by hand on `main` | the manifest version, as is               |

What each channel ships:

- **canary** publishes every package to npm under the `canary` tag and packages the desktop app as "CodeWork Canary" for macOS arm64, Linux x64 and arm64, and Windows x64 and arm64. It replaces the `nightly` prerelease with those installers. It skips `vp run verify` and builds no CLI binary: canary is push-and-build for quick testing.
- **dev** runs `vp run verify`, publishes every package under the `dev` tag, and replaces the `devel` prerelease with the CLI binaries. The installer's `--dev` flag downloads from `devel`, so it has a fixed URL.
- **latest** runs `vp run verify` and publishes each package whose manifest version is not on npm yet. It creates a `<pkg>@v<version>` GitHub Release for each package that has none. The CLI's release carries the binaries and is created last, so `releases/latest`, which the installer reads, points at it.

The desktop app is packaged on canary only. `vp run bump desktop` changes the base version that canary builds carry; latest makes no desktop installer or desktop GitHub Release. [electron.config.ts](../../apps/desktop/electron.config.ts) already gives each channel its own product name, app id and data directory, so channels install side by side.

## One Version per Run

The first job computes the run's release id once ([version.mjs](../../scripts/version.mjs)) and hands it to every later job as `CODEWORK_RELEASE_ID`. The npm packages, the binary's reported version and the desktop build therefore share one release id, each on its own base version. A canary or dev release id can only be made in CI; locally only `--dry-run` is accepted.

A prerelease carries its channel in its version string, and a version without one is `latest`. Telemetry reads the channel from it (see [telemetry](./12_telemetry.md)), so the version format is load-bearing.

## Publishing the Package Chain

[release.mjs](../../scripts/release.mjs) publishes the packages one at a time, each after the workspace packages it depends on. The order comes from the `package.json` graph ([workspace.mjs](../../scripts/workspace.mjs)), not from a hand-kept list. Private packages and the paused TUI are never published.

[publish.mjs](../../scripts/publish.mjs) handles one package. Decisions that matter:

- **It builds with the version being published.** A bundle that imports its `package.json` inlines the version, so the manifest is rewritten for the build and restored after.
- **It publishes from a temp directory** holding `dist/pack`, a rewritten manifest, the README and the license. Sources are never in the tarball, so the `development` export condition, which points at `src/*.ts`, is stripped.
- **Workspace ranges are resolved, never guessed.** A dependency uploaded earlier in the same run is taken at that exact version, since npm may still be scanning it. Anything else must already be on npm at its manifest version, or the publish fails before building.
- **Prereleases are pinned exactly.** A range would also match another build of the same channel. A stable release keeps the range form of the workspace spec: `workspace:^` becomes `^<version>`, `workspace:*` the exact version.
- **`latest` means stable.** A prerelease is refused under `latest`, and a stable version is refused under any other tag.

After every upload is accepted, the run waits until each version is on the registry and its dist-tag points at it. npm scans uploads before exposing them, which has taken more than 15 minutes, so the wait allows up to an hour. Registry checks use endpoints the npm CDN does not cache ([registry.mjs](../../scripts/registry.mjs)); `npm view` can report a just-published version as missing for minutes.

Ordering between jobs follows one rule: a GitHub Release never names a version npm does not have. The `release` and `nightly` jobs wait for the npm job. The npm job runs on a GitHub-hosted runner because npm accepts provenance and trusted publishing only from those.

## The CLI Binary

The `codework` binary is a Node single executable application. `@codeworksh/cli` is also published to npm as a plain package for people who already have Node.

- [bundle.mjs](../../packages/codework/scripts/bundle.mjs) bundles the CLI from [sea.ts](../../packages/codework/src/sea.ts) into one ESM file. Packages that load files from beside their own modules (WASM, workers, native addons) cannot be bundled. They are copied as assets instead, and `node-liblzma` is rebuilt with xz linked statically, because a user's machine may lack liblzma.
- [sea.mjs](../../packages/codework/scripts/sea.mjs) downloads a pinned official Node, checks its hash and injects the bundle. Injection breaks a macOS signature, so the binary is signed again ad hoc. Snapshots and code cache are off because they would tie the binary to the build machine's V8 flags.
- At start, [sea.ts](../../packages/codework/src/sea.ts) unpacks the assets into a per-user cache keyed by their content hash, so a build never runs another build's files. The cache is in the shared temp directory, so it refuses a directory another user owns or one swapped for a symlink.
- A plugin installed by the binary has no `effect` on disk to resolve. The binary shares its own copy of `effect` and `@codeworksh/plugin` with plugins before the CLI starts.

Targets are macOS arm64 and Linux arm64 and x64, each built on its own platform because `--build-sea` runs that platform's Node. Intel Macs and Windows are not targets. Before upload, CI runs [sea.test.ts](../../packages/codework/test/sea.test.ts) against the binary with only system directories on `PATH`. The release carries a `SHA256SUMS` file, which the installer checks each download against.

## Bumping and the Flow

Releases move through three branches: `canary` → `dev` → `main`. Work lands on `canary` through squash-merged pull requests, and every push there publishes a canary. `canary` is merged into `dev`. Versions are bumped on `dev` just before a release, and `main` never bumps.

`vp run bump <aikit|plugin|harness|cli|desktop> [version]` runs `bumpp` in that package ([bump.mjs](../../scripts/bump.mjs)). Its `bump.config.ts` commits as `release: <pkg>@v<version>`, tags `<pkg>@v<version>` and never pushes. Note that the npm package `@codeworksh/cli` is tagged `cli@v…`.

1. On `dev`, update `CHANGELOG.md`. The maintainers write release notes by hand, and nothing generates or edits this file.
2. `vp run bump <pkg>` for each package being released.
3. `git push && git push --tags`. The push runs the dev Publish.
4. Once that run is green, merge `dev` into `main`.
5. Run the Publish workflow by hand on `main`.

A package whose version is already on npm is skipped, so rerunning latest is safe. The GitHub Release reuses the tag `vp run bump` made, or creates one at the current commit. `vp run release <channel> --dry-run` previews the chain locally. It still builds each package and passes `--dry-run` to `npm publish`.
