# Canary publishing

Every push to `canary` (including a merged pull request) runs `workflows/canary.yml`,
except pushes that only change `sites/www/**`. Website dependencies and checks
are excluded from this publishing workflow.
Checks must pass before publishing `@codeworksh/aikit`, `@codeworksh/plugin`,
`@codeworksh/harness`, and `@codeworksh/cli`, in dependency order.

Publishing uses npm trusted publishing (OIDC), so no `NPM_TOKEN` secret is needed.
For each of the four packages on npmjs.com, open Settings → Trusted Publisher,
select GitHub Actions, and enter:

- Organization or user: `codeworksh`
- Repository: `codework`
- Workflow filename: `canary.yml` (filename only)
- Environment name: leave empty (the workflow does not use a GitHub environment)
- Allowed actions: enable direct publishing with `npm publish`

Merge the workflow into `canary` to activate it. It grants `id-token: write` and
uses GitHub-hosted runners. npm handles the OIDC token exchange automatically;
the existing publish script preserves GitHub's OIDC environment variables.
Trusted publishing requires npm CLI 11.5.1+ and Node 22.14.0+; setup-vp installs
Node 24 and its bundled npm.

After a successful OIDC publish, remove any unused `NPM_TOKEN` Actions secret
and revoke its npm token. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Versions use `<manifest-version>-canary.<run-number>.<attempt>.g<commit>` so each
run and retry publishes a new version without changing tracked manifests.
Workspace dependencies resolve to the versions published by the same run.
All publishes use the `canary` dist-tag; `latest` stays unchanged.

Install with `pnpm add @codeworksh/cli@canary` (or another package's `@canary` tag).
Uploads run in dependency order without waiting for npm scanning between them.
Consumers pin exact canary versions only after their dependency uploads succeed,
using the publish script's `--uploaded-dep` option. Regular `--dep` still requires
a version already available on the registry.
After all uploads succeed, the workflow checks all four versions and their
`canary` tags concurrently, waiting up to 60 minutes for npm's scanning.
A failed run may have uploaded some packages already. A timeout does not cancel
the upload. Check the package's Versions tab and npm notifications for scanning,
manual review, or blocking before retrying. See [npm's scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
Re-run the workflow to publish a fresh, complete set.
