import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { probe } from "../src/plugin/npm.ts";
import { add } from "../src/plugin/store.ts";
import { parse, type Fetchable } from "../src/plugin/source.ts";
import { NAME, npmrc, withRegistry } from "./fixtures/registry.ts";

/*
 * The npm toolchain against a real registry and a real git remote, both on this machine.
 *
 * `plugin.npm.live.test.ts` proves arborist and pacote behave as assumed against the public
 * registry. This file proves the things a *public* registry cannot: that an install reads the
 * `.npmrc` the person's own directory declares, that no audit is ever requested, and that a
 * lifecycle script never runs -- each of which is invisible in a passing install and only shows up
 * as a security or auth failure much later.
 */

const run = promisify(execFile);

const withDirectory = async (body: (directory: string) => Promise<void>) => {
	const directory = await mkdtemp(join(tmpdir(), "plugin-registry-"));
	try {
		await body(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const fetchable = (spec: string) => Effect.runSync(parse(spec, "/unused")) as Fetchable;
const accept = () => Effect.succeed("ok" as const);

describe("an install against a private registry", () => {
	it("resolves through the .npmrc the host directory declares, not the one where it stages", () =>
		withDirectory(async (directory) =>
			withRegistry(join(directory, "packages"), async (registry) => {
				const host = join(directory, "project");
				await npmrc(host, registry);
				const cache = join(directory, "cache");

				const added = await Effect.runPromise(
					add(fetchable(`${NAME}@^1.0.0`), cache, { from: host, validate: accept }),
				);

				/*
				 * `@fixture/plugin` exists on no public registry, so an install that reached one
				 * fails rather than installing something else. That is the whole assertion: the
				 * chain was read where the person is. Staging lives under `cache`, and a chain
				 * read there would have found nothing -- which is what shipped until §15 Q2.
				 */
				expect(added.entry.version).toBe("1.0.0");
				expect(existsSync(new URL(added.entry.url))).toBe(true);
				expect(registry.paths()).toContain(`/${NAME}`);
			}),
		));

	it("asks for no audit report", () =>
		withDirectory(async (directory) =>
			withRegistry(join(directory, "packages"), async (registry) => {
				const host = join(directory, "project");
				// `audit=true` in the person's own config, to prove ours is the one that decides.
				await npmrc(host, registry, "audit=true\n");

				await Effect.runPromise(
					add(fetchable(`${NAME}@1.0.0`), join(directory, "cache"), { from: host, validate: accept }),
				);

				// Arborist waits on a report we never read, so we turn it off. A registry that is
				// slow to answer would otherwise hold up every install for nothing.
				expect(registry.audits()).toBe(0);
			}),
		));

	it("runs no lifecycle script, whatever the project's own .npmrc asks for", () =>
		withDirectory(async (directory) => {
			const marker = join(directory, "postinstall-ran");
			await withRegistry(
				join(directory, "packages"),
				async (registry) => {
					const host = join(directory, "project");
					/*
					 * Both of npm's own gates, turned off by the repository itself -- which it
					 * may do, in a file we now genuinely read (§15 Q2). npm 12 added a second
					 * one (`allow-scripts`, npm/rfcs#868) that blocks an unreviewed package even
					 * when `ignore-scripts` is false, and `dangerously-allow-all-scripts` is the
					 * documented way past it. With both off, ours is the only gate left, which is
					 * the point: a test that leans on npm's defaults passes whether we set
					 * `ignoreScripts` or not.
					 */
					await npmrc(host, registry, "ignore-scripts=false\ndangerously-allow-all-scripts=true\n");

					await Effect.runPromise(
						add(fetchable(`${NAME}@1.0.0`), join(directory, "cache"), { from: host, validate: accept }),
					);

					/*
					 * A lifecycle script runs at *install* time -- before anyone has decided to
					 * trust this code, and before the module is even imported. `ignoreScripts` is
					 * set on the Arborist constructor, which is the only place arborist reads it
					 * from (`rebuild.js` checks `this.options`), so neither a per-call option nor
					 * a config file can put it back.
					 */
					expect(existsSync(marker)).toBe(false);
				},
				{ scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` } },
			);
		}));

	it("reports the newer version a moving range points at, from the same chain", () =>
		withDirectory(async (directory) =>
			withRegistry(join(directory, "packages"), async (registry) => {
				const host = join(directory, "project");
				await npmrc(host, registry);
				const cache = join(directory, "cache");
				const target = fetchable(`${NAME}@^1.0.0`);

				await Effect.runPromise(add(target, cache, { from: host, validate: accept }));
				registry.publish("1.1.0");

				// `probe` has to read the same `.npmrc` as the install: a staleness check pointed
				// at a different registry answers about a package nothing is ever fetched from.
				expect(await Effect.runPromise(probe(target, cache, host))).toBe("1.1.0");
			}),
		));
});

describe("an install from a git remote on disk", () => {
	const repository = async (directory: string) => {
		const root = join(directory, "repository");
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture-git-plugin", version: "1.0.0", type: "module", exports: "./index.js" }),
		);
		await writeFile(join(root, "index.js"), "export default { id: 'fixture.git' };\n");
		const git = (...args: string[]) => run("git", args, { cwd: root });
		await git("init", "-q", "-b", "trunk");
		await git("config", "user.email", "fixture@example.com");
		await git("config", "user.name", "Fixture");
		await git("add", ".");
		await git("commit", "-qm", "fixture");
		return { root, commit: (await git("rev-parse", "HEAD")).stdout.trim() };
	};

	it("fetches a branch and recovers the commit, with no network", () =>
		withDirectory(async (directory) => {
			const { root, commit } = await repository(directory);
			const spec = `git+${pathToFileURL(root).href}#trunk`;

			const added = await Effect.runPromise(
				add(fetchable(spec), join(directory, "cache"), { from: directory, validate: accept }),
			);

			/*
			 * Two things at once, both of which failed silently before they were tested. npm 12
			 * defaults `allow-git` to `none`, so without `allowGit: "root"` this never opens a
			 * connection at all (T8) -- and the revision has to be the commit rather than the
			 * manifest version, or a branch that moves without a version bump reports an update
			 * forever and never applies one (T2).
			 */
			expect(added.entry.revision).toBe(commit);
			expect(added.entry.version).toBe("1.0.0");
		}));

	it("sees a branch move, and files the new commit", () =>
		withDirectory(async (directory) => {
			const { root } = await repository(directory);
			const spec = `git+${pathToFileURL(root).href}#trunk`;
			const cache = join(directory, "cache");
			const first = await Effect.runPromise(add(fetchable(spec), cache, { from: directory, validate: accept }));

			await writeFile(join(root, "index.js"), "export default { id: 'fixture.git', moved: true };\n");
			await run("git", ["add", "."], { cwd: root });
			await run("git", ["commit", "-qm", "moved"], { cwd: root });
			const moved = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

			// The manifest version did not change, so only the commit can show the branch moved.
			expect(await Effect.runPromise(probe(fetchable(spec), cache, directory))).toBe(moved);
			expect(first.entry.revision).not.toBe(moved);
		}));
});
