import { Effect } from "effect";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { InstallError } from "../src/plugin/error.ts";
import { download, entrypoint, options, type Runner } from "../src/plugin/npm.ts";
import { parse, type Fetchable } from "../src/plugin/source.ts";

/** Domain 1 against a temp directory, with a runner that copies a fixture. Nothing is installed. */

const withDirectory = async (body: (directory: string) => Promise<void>) => {
	const directory = await mkdtemp(join(tmpdir(), "plugin-npm-"));
	try {
		await body(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const fetchable = (spec: string) => Effect.runSync(parse(spec, "/unused")) as Fetchable;

/** Writes what arborist would have installed, and reports the tree it would have returned. */
const runner =
	(options: { readonly lockfile?: string; readonly manifest?: object } = {}): Runner =>
	({ target, into }) =>
		Effect.promise(async () => {
			const name = target.kind === "registry" ? target.name : target.slug;
			const root = join(into, "node_modules", name);
			await mkdir(root, { recursive: true });
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ name, version: "1.4.2", type: "module", exports: "./index.js", ...options.manifest }),
			);
			await writeFile(join(root, "index.js"), "export default {}");
			if (options.lockfile !== undefined) await writeFile(join(into, "package-lock.json"), options.lockfile);
			return { edgesOut: new Map([[name, { to: { name, path: root } }]]) };
		});

const staging = async (directory: string) => {
	const into = join(directory, "staging");
	await mkdir(into, { recursive: true });
	await writeFile(join(into, "package.json"), '{"private":true,"type":"module"}');
	return into;
};

describe("download", () => {
	it("fails a git install whose commit cannot be recovered, rather than using the version", () =>
		withDirectory(async (directory) => {
			const into = await staging(directory);
			// No lockfile at all: nothing to recover the commit from.
			const failure = await Effect.runPromise(
				Effect.flip(
					download({
						target: fetchable("github:acme/plugins#main"),
						into,
						cache: directory,
						from: directory,
						runner: runner(),
					}),
				),
			);
			// Falling back to "1.4.2" here would make `check` report an update forever and `add`
			// discard the bytes it just fetched, because version would always equal version.
			expect(failure).toBeInstanceOf(InstallError);
			expect(failure.reason).toBe("plugin-no-commit");
		}));

	it("installs through the real path of the staging directory", () =>
		withDirectory(async (directory) => {
			// macOS hands out `/var/...` for a directory that really lives at `/private/var/...`.
			// Reified through the symlinked spelling, arborist returns a tree with no root edges
			// and a lockfile keyed by `../../…` paths: the install silently reports nothing.
			const real = join(directory, "real");
			await mkdir(real, { recursive: true });
			await writeFile(join(real, "package.json"), '{"private":true,"type":"module"}');
			const link = join(directory, "link");
			await symlink(real, link);

			const seen: string[] = [];
			const spy: Runner = (input) => {
				seen.push(input.into);
				return runner()(input);
			};
			await Effect.runPromise(
				download({ target: fetchable("acme@1.0.0"), into: link, cache: directory, from: directory, runner: spy }),
			);
			// The whole chain is resolved, not just the last link.
			expect(seen).toEqual([realpathSync(real)]);
		}));
});

describe("entrypoint", () => {
	it("prefers a package's own ./plugin export over its main", () =>
		withDirectory(async (directory) => {
			const root = join(directory, "node_modules", "acme");
			await mkdir(root, { recursive: true });
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ name: "acme", exports: { ".": "./main.js", "./plugin": "./plugin.js" } }),
			);
			await writeFile(join(root, "main.js"), "export default {}");
			await writeFile(join(root, "plugin.js"), "export default {}");
			// `.` is tried first, so a package that publishes both keeps its documented main.
			expect((await Effect.runPromise(entrypoint(directory, "acme"))).endsWith("main.js")).toBe(true);
		}));

	it("falls back to a dedicated ./plugin export when the package has no main", () =>
		withDirectory(async (directory) => {
			const root = join(directory, "node_modules", "acme");
			await mkdir(root, { recursive: true });
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ name: "acme", exports: { "./plugin": "./plugin.js" } }),
			);
			await writeFile(join(root, "plugin.js"), "export default {}");
			expect((await Effect.runPromise(entrypoint(directory, "acme"))).endsWith("plugin.js")).toBe(true);
		}));
});

/*
 * Where auth comes from, asserted on the config that produces it -- see §15 Q2.
 */
describe("options", () => {
	it("names no env, so git keeps the ambient agent and credential helper", () =>
		withDirectory(async (directory) => {
			const flat = await Effect.runPromise(options(directory, join(directory, "cache")));
			/*
			 * npm hands git `opts.env` when one is present and falls back to
			 * `{ ...gitDefaults, ...process.env }` when it is not. An `env` here -- even a copy of
			 * `process.env` -- would put private git auth one careless prune away from breaking,
			 * with no error to read: `SSH_AUTH_SOCK` is how the agent is found, `HOME` is how
			 * `~/.gitconfig` names the credential helper, and `PATH` is how `git` itself is found.
			 */
			expect("env" in flat).toBe(false);
		}));
});

/*
 * The one spelling that is wrong *silently*.
 *
 * Every other wrong-directory bug in this module -- T7, T9, T10 -- was a perfectly valid absolute
 * path that answered about the wrong tree, and no assertion can catch those. A relative one is
 * different in kind: node and npm both resolve it against `process.cwd()` without a word, so the
 * answer comes from whatever directory the process was started in. That is worth refusing.
 */
describe("a relative directory", () => {
	it("is refused where a plugin reference would anchor to it", async () => {
		// `./plugin.ts` against `packages/x` would resolve under the *process* directory, which
		// for a server is nobody's project.
		await expect(Effect.runPromise(parse("./plugin.ts", "packages/x"))).rejects.toThrow(/absolute path/);
	});

	it("is refused where npm would read the .npmrc chain from it", async () => {
		// Measured: npm answers a relative `cwd` with a `localPrefix` of whatever repository the
		// process happens to be inside, and reports no problem at all.
		await expect(Effect.runPromise(options("some/relative/dir", "/tmp/cache"))).rejects.toThrow(/absolute path/);
		await expect(Effect.runPromise(options("/tmp/project", "relative-cache"))).rejects.toThrow(/absolute path/);
	});
});
