import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { download, probe } from "../src/plugin/npm.ts";
import { add, resolve } from "../src/plugin/store.ts";
import { parse, type Fetchable } from "../src/plugin/source.ts";

/*
 * The one thing a fixture cannot prove: that arborist and pacote really behave as the rest of the
 * code assumes. Everything else about Domain 1 is tested hermetically.
 *
 * Two facts are load-bearing and neither is observable without a network:
 *
 * 1. A git install's commit is recoverable from the `package-lock.json` arborist writes. Falling
 *    back to the manifest version instead would break updates unrecoverably -- a branch that moves
 *    without bumping `package.json` would report "update available" forever and never apply one --
 *    so the recovery has to be proven, not assumed.
 * 2. `probe` answers from the network rather than pacote's own metadata cache. A staleness check
 *    that reads a cache is not a staleness check.
 *
 * Both reach the npm registry and github, so this file fails when they are unreachable. The
 * packages are chosen to be tiny and long-stable.
 */

const withStaging = (body: (input: { into: string; home: string }) => Promise<void>) =>
	Effect.runPromise(
		Effect.promise(async () => {
			const root = await mkdtemp(join(tmpdir(), "plugin-npm-live-"));
			try {
				const into = join(root, "staging");
				await Effect.runPromise(
					Effect.promise(async () => {
						const { mkdir } = await import("node:fs/promises");
						await mkdir(into, { recursive: true });
						// Arborist wants a manifest to install into.
						await writeFile(join(into, "package.json"), '{"private":true,"type":"module"}');
					}),
				);
				await body({ into, home: join(root, "home") });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}),
	);

const fetchable = (spec: string) => Effect.runSync(parse(spec, "/unused")) as Fetchable;

describe("the npm toolchain, against the real registry", () => {
	it("installs an exact version and reports it as the revision", { timeout: 120_000 }, async () =>
		withStaging(async ({ into, home }) => {
			const target = fetchable("is-number@7.0.0");
			const fetched = await Effect.runPromise(download({ target, into, cache: home, from: into }));

			expect(fetched.name).toBe("is-number");
			expect(fetched.version).toBe("7.0.0");
			// For a registry package the revision *is* the version; there is nothing else to
			// compare a later resolve against.
			expect(fetched.revision).toBe("7.0.0");
			expect(fetched.entrypoint).toContain("is-number");

			// An exact version cannot move, so `probe` never opens a socket for it.
			expect(await Effect.runPromise(probe(target, home, into))).toBeUndefined();
		}),
	);

	it(
		"recovers the commit a git branch resolved to, from the lockfile arborist wrote",
		{ timeout: 180_000 },
		async () =>
			withStaging(async ({ into, home }) => {
				const target = fetchable("github:jonschlinkert/is-number#master");
				const fetched = await Effect.runPromise(download({ target, into, cache: home, from: into }));

				expect(fetched.name).toBe("is-number");
				// The whole point: a 40-hex commit, never the branch name and never the manifest
				// version standing in for one.
				expect(fetched.revision).toMatch(/^[a-f0-9]{40}$/i);
				expect(fetched.revision).not.toBe(fetched.version);
			}),
	);

	it("resolves what a range and a branch point at right now, without installing", { timeout: 120_000 }, async () =>
		withStaging(async ({ home }) => {
			// A range is mutable, so this is a real call and the answer is a concrete version.
			const version = await Effect.runPromise(probe(fetchable("is-number@^7"), home, home));
			expect(version).toMatch(/^7\./);

			const commit = await Effect.runPromise(probe(fetchable("github:jonschlinkert/is-number#master"), home, home));
			expect(commit).toMatch(/^[a-f0-9]{40}$/i);
		}),
	);

	it("refuses a spec that does not exist, rather than installing something else", { timeout: 120_000 }, async () =>
		withStaging(async ({ into, home }) => {
			const failure = await Effect.runPromise(
				Effect.flip(
					download({
						target: fetchable("@codeworksh/definitely-not-a-real-plugin@1.0.0"),
						into,
						cache: home,
						from: into,
					}),
				),
			);
			expect(failure.reason).toBe("plugin-fetch-failed");
		}),
	);
});

describe("the store, against the real registry", () => {
	it("installs, publishes and resolves a real package end to end", { timeout: 180_000 }, async () =>
		withStaging(async ({ home }) => {
			const target = fetchable("is-number@7.0.0");
			const added = await Effect.runPromise(
				add(target, home, { from: home, validate: () => Effect.succeed("ok" as const) }),
			);
			expect(added.entry.version).toBe("7.0.0");
			expect(added.validated).toBe("ok");
			expect(existsSync(fileURLToPath(added.entry.url))).toBe(true);

			// Filed, so the next lookup needs neither the lock nor the network.
			const found = await Effect.runPromise(resolve(target, home));
			expect(found?.url).toBe(added.entry.url);

			// And the tarball landed in our npm cache, not the developer's `~/.npm`.
			expect(existsSync(join(home, "npm", "_cacache"))).toBe(true);
		}),
	);
});

/*
 * §15 Q2, the half a public remote cannot answer: does auth reach a **private** git source?
 *
 * Nothing about it is ours. We hand npm no `env`, so `@npmcli/git` spawns git with
 * `{ ...gitDefaults, ...process.env }` -- the agent behind `SSH_AUTH_SOCK`, the credential helper
 * named in the `~/.gitconfig` that `HOME` points at, and the `git` that `PATH` finds. That is the
 * mechanism; this is the proof that it holds end to end, and it is the one thing in this file that
 * cannot be always-on, because a private remote is by definition not one everyone can reach.
 *
 * Point it at a repository you can clone and run the suite:
 *
 *   CODEWORK_LIVE_PRIVATE_GIT=git+ssh://git@github.com/acme/private-plugin.git#main vp test
 *
 * Both spellings are worth a run: `git+ssh://` exercises the agent, `git+https://` exercises the
 * credential helper. `probe` is the whole question -- arborist reaches git through the same pacote
 * fetcher and the same `@npmcli/git` spawn, so an authenticated `probe` is an authenticated
 * install.
 */
describe("a git remote the ambient credentials cannot reach", () => {
	it("fails instead of waiting for a password", { timeout: 120_000 }, async () =>
		withStaging(async ({ into, home }) => {
			/*
			 * A private repository is indistinguishable from a missing one to an unauthenticated
			 * client: github answers 404 either way, and git's reflex is to ask for a username.
			 * npm sets `GIT_ASKPASS=echo` when the environment does not already name one, so the
			 * ask is answered with nothing and the fetch fails -- which is what keeps a wrong
			 * remote in a settings file from hanging a run forever with no output.
			 *
			 * Always on, because it needs no credentials: the authenticated half is below.
			 */
			const target = fetchable("git+https://github.com/codeworksh/not-a-real-private-repo.git#main");
			const failure = await Effect.runPromise(Effect.flip(probe(target, home, into)));
			expect(failure.reason).toBe("plugin-resolve-failed");
		}),
	);
});

const privateGit = process.env.CODEWORK_LIVE_PRIVATE_GIT;
const authenticated = privateGit === undefined ? it.skip : it;

describe("a private git remote", () => {
	authenticated("resolves through the ambient ssh agent or credential helper", { timeout: 180_000 }, async () =>
		withStaging(async ({ into, home }) => {
			const spec = privateGit ?? "";
			const target = fetchable(spec);
			// A mutable committish, or there is no network call to make and nothing is proven.
			expect(target.mutable).toBe(true);

			const commit = await Effect.runPromise(probe(target, home, into));
			// A commit, not a redirect to a login page and not a branch name: git answered.
			expect(commit).toMatch(/^[a-f0-9]{40}$/i);
		}),
	);
});
