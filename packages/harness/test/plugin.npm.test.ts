import { Effect } from "effect";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { download, entrypoint, options, type Runner } from "../src/plugin/npm.ts";
import { InstallError } from "../src/plugin/error.ts";
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

const lock = (name: string, resolved: string) =>
	JSON.stringify({ packages: { [`node_modules/${name}`]: { resolved } } });

describe("download", () => {
	it("reports a registry install's version as its revision", () =>
		withDirectory(async (directory) => {
			const into = await staging(directory);
			const fetched = await Effect.runPromise(
				download({ target: fetchable("acme@^1"), into, cache: directory, from: directory, runner: runner() }),
			);
			expect(fetched).toMatchObject({ name: "acme", version: "1.4.2", revision: "1.4.2" });
			expect(fetched.entrypoint.endsWith("index.js")).toBe(true);
		}));

	it("recovers a git install's commit from the lockfile, never its manifest version", () =>
		withDirectory(async (directory) => {
			const into = await staging(directory);
			const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
			const fetched = await Effect.runPromise(
				download({
					target: fetchable("github:acme/plugins#main"),
					into,
					cache: directory,
					from: directory,
					runner: runner({ lockfile: lock("plugins", `git+ssh://git@github.com/acme/plugins.git#${sha}`) }),
				}),
			);
			expect(fetched.revision).toBe(sha);
			// The version is still reported, and is still not the revision: a branch that moves
			// without bumping `package.json` has to be detectable, and only the commit shows it.
			expect(fetched.version).toBe("1.4.2");
		}));

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

	it("resolves a local target in place, without installing it", () =>
		withDirectory(async (directory) => {
			const local = join(directory, "plugin");
			await mkdir(local, { recursive: true });
			await writeFile(join(local, "package.json"), JSON.stringify({ name: "local", exports: "./index.js" }));
			await writeFile(join(local, "index.js"), "export default {}");

			const fetched = await Effect.runPromise(
				download({
					target: { kind: "local", path: local },
					into: "/unused",
					cache: directory,
					from: directory,
					runner: () => Effect.die(new Error("a local target must never be installed")),
				}),
			);
			expect(fetched.directory).toBe(local);
			// Nothing to compare a re-resolve against: a local plugin is never filed.
			expect(fetched.revision).toBeUndefined();
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

	it("reports a package with nothing to import as having no entrypoint", () =>
		withDirectory(async (directory) => {
			const root = join(directory, "node_modules", "acme");
			await mkdir(root, { recursive: true });
			await writeFile(join(root, "package.json"), JSON.stringify({ name: "acme", exports: {} }));
			const failure = await Effect.runPromise(Effect.flip(entrypoint(directory, "acme")));
			expect(failure.reason).toBe("plugin-no-entrypoint");
		}));
});

/*
 * Where auth comes from. Neither half of it is visible in an install's result, so both are
 * asserted on the config that produces them -- see §15 Q2.
 */
describe("options", () => {
	const project = async (directory: string) => {
		const from = join(directory, "project", "packages", "app");
		await mkdir(from, { recursive: true });
		// The token lives at the repository root, not in the directory the person is standing in.
		const root = join(directory, "project");
		await writeFile(join(root, "package.json"), '{"name":"acme-project"}');
		await writeFile(
			join(root, ".npmrc"),
			"@acme:registry=https://registry.acme.invalid/\n//registry.acme.invalid/:_authToken=s3cret\n",
		);
		return { root, from };
	};

	it("reads the .npmrc chain where the person is, walking up as npm would", () =>
		withDirectory(async (directory) => {
			const { from } = await project(directory);
			const flat = await Effect.runPromise(options(from, join(directory, "cache")));
			// A private registry and its token, from a file two directories above `from`. Pinning
			// npm's local prefix would find neither.
			expect(flat["//registry.acme.invalid/:_authToken"]).toBe("s3cret");
			expect(flat["allowGit"]).toBe("root");
		}));

	it("does not read it from the staging directory the package is installed into", () =>
		withDirectory(async (directory) => {
			await project(directory);
			// Staging lives inside the store, under the cache. It is where the bytes land and it
			// has nothing to do with the repository whose plugin is being installed -- a chain
			// read here resolves a private scope against the public registry.
			const staging = join(directory, "cache", "plugins", "v1", "acme", "staging");
			await mkdir(staging, { recursive: true });
			const flat = await Effect.runPromise(options(staging, join(directory, "cache")));
			expect(flat["//registry.acme.invalid/:_authToken"]).toBeUndefined();
		}));

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
