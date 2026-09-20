/* oxlint-disable typescript/triple-slash-reference -- The three npm libraries publish no types and
   have no `@types/*` package, so the declarations are ours. A reference keeps them attached to the
   module that needs them, which an import cannot do for an ambient `declare module`, and which
   `include` cannot do for the other packages that compile this file. */
/// <reference path="./npm.types.d.ts" />
/* oxlint-disable effecttsgo/async-function -- npm's libraries are promise-based; these are the
   bridge into Effect, and awaiting inside `tryPromise` is what that bridge looks like. */
/*
 * @file Domain 1: a Target becomes bytes in a directory, plus the facts needed to file them.
 *
 * Stateless. It knows nothing about the store -- no layout, no locking, no generations -- which
 * is what lets it be tested against a temp directory with no store at all.
 *
 * **No package manager binary is spawned.** npm's own libraries do the work, called in process:
 * `@npmcli/arborist` installs, `pacote` resolves, `@npmcli/config` reads the `.npmrc` chain. Four
 * reasons, and the first is the one that matters most:
 *
 * 1. Nothing has to be installed first. `codework` ships as a binary; spawning a package manager
 *    would make every install depend on a tool the user may not have, at a version we do not
 *    control. Installing a plugin is a first-run experience.
 * 2. The installed identity comes back as data -- the tree's own edge names the package that was
 *    added, with its real name and path. Nothing is inferred from the spec.
 * 3. `ignoreScripts` is enforced by us, in the same call. A lifecycle script runs at *install*
 *    time, before anyone has decided to trust this code.
 * 4. One family, one grammar. Every spec npa accepts is one arborist handles.
 *
 * Picking one of the three libraries is picking all three: the commit a git install resolved to is
 * recovered from the `package-lock.json` that arborist writes, and a different installer would
 * write a different lockfile, or none.
 */

import { Effect, Option, Schema } from "effect";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileSystem as fs, hostPath as path } from "../host.ts";
import { resolveModule } from "../util/module.ts";
import { InstallError } from "./error.ts";
import { rooted } from "../util/path.ts";
import type { Fetchable, Target } from "./source.ts";

/** What an install produced, and everything downstream needs to file it. */
export interface Fetched {
	/** Where the package landed. For a local target, the files that were already there. */
	readonly directory: string;
	readonly name: string;
	readonly version?: string;
	/**
	 * What `check` compares against what is filed: a registry version, or a git commit SHA. Absent
	 * only for a local target, which has no revision because it is never filed.
	 */
	readonly revision?: string;
	/** Absolute path to the module to import. */
	readonly entrypoint: string;
}

const Manifest = Schema.Struct({ version: Schema.optional(Schema.String) });

const Lockfile = Schema.Struct({
	packages: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ resolved: Schema.optional(Schema.String) }))),
});

/**
 * npm's flattened config: registry, scopes, auth, and cache paths.
 *
 * Built in one place, because two call sites deriving it separately is how the cache location
 * drifts between an install and the staleness check that is supposed to describe it.
 *
 * `dir` is where the `.npmrc` chain is read from, and it is the **host directory the caller
 * belongs to** -- never the staging directory and never the cache. A company repo keeps its
 * private registry and its scoped token in its own `.npmrc`, so a chain read anywhere else
 * resolves the plugin against the public registry and fails 404, or worse, installs a public
 * package of the same name. This is the registry half of auth; the git half is below.
 *
 * No `--prefix`. npm pins its local prefix to a `--prefix` on `argv` and stops walking, so
 * passing one would look up exactly `<dir>/.npmrc` and nothing above it -- wrong for a person
 * standing in `packages/x` whose token lives at the repository root. Without it npm walks up from
 * `cwd` to the nearest `package.json` or `node_modules` exactly as `npm` itself would if it were
 * run there, which is the only rule a user can predict.
 *
 * `--cache` is ours and is passed on `argv`, which outranks every `.npmrc`. npm's `flatten`
 * derives `_cacache`, `_npx` and `_tuf` from that one value, so naming the parent is enough --
 * and overriding `flat.cache` afterwards would redirect one of the three and leave `_tuf` pointing
 * at the user's home. `--home` exists to make a run self-contained; anything reached by an ambient
 * default is a test reading the developer's real machine.
 *
 * **Nothing here names an `env`.** npm hands git `opts.env` when one is present and falls back to
 * `{ ...gitDefaults, ...process.env }` when it is not, so leaving it out is what lets a git source
 * reach a private remote at all: `SSH_AUTH_SOCK` finds the agent, `HOME` finds the `~/.gitconfig`
 * that names the credential helper, and `PATH` finds `git`. Setting `env` to anything -- even to
 * a copy of `process.env` -- would be a standing invitation to prune it later and break private
 * git silently, months from the change. §15 Q2.
 */
export const options = (
	dir: string,
	cache: string,
	reference = dir,
): Effect.Effect<Record<string, unknown>, InstallError> =>
	Effect.suspend(() => {
		const root = rooted(dir, "the directory a plugin install reads its .npmrc chain from");
		const store = rooted(cache, "the npm cache");
		return npmOptions(root, store, reference);
	});

const npmOptions = (
	dir: string,
	cache: string,
	reference: string,
): Effect.Effect<Record<string, unknown>, InstallError> =>
	Effect.tryPromise({
		try: async () => {
			const { default: Config } = await import("@npmcli/config");
			const { definitions, flatten, nerfDarts, shorthands } = (
				await import("@npmcli/config/lib/definitions/index.js")
			).default;
			const config = new Config({
				npmPath: fileURLToPath(new URL("..", import.meta.url)),
				cwd: dir,
				env: { ...process.env },
				argv: [process.execPath, process.execPath, "--cache", path.join(cache, "npm")],
				execPath: process.execPath,
				platform: process.platform,
				definitions,
				flatten,
				nerfDarts,
				shorthands,
				warn: false,
			});
			await config.load();
			for (const kind of ["project", "user", "global"] as const) {
				const loaded = config.data.get(kind);
				if (loaded?.loadError !== undefined && loaded.loadError.code !== "ENOENT") {
					throw new InstallError({
						reason: "plugin-resolve-failed",
						reference,
						message: `cannot read npm configuration ${loaded.source ?? kind}`,
						cause: loaded.loadError,
					});
				}
			}
			return {
				...(config.flat as Record<string, unknown>),
				/*
				 * npm 12 defaults `allow-git` to `none`, so a git plugin source fails with `EALLOWGIT`
				 * before a socket is opened. We support git sources deliberately (a plugin published
				 * straight from a repository is a normal thing to want), so the opt-in is ours to make.
				 *
				 * `root`, not `all`. It permits the git source the person named -- a direct dependency
				 * of the staging package, and the `_isRoot` spec a `probe` asks about -- while still
				 * refusing a git dependency that some *other* package drags in transitively. That is
				 * the case npm's default exists to stop: a remote repo whose `.gitconfig` and hooks
				 * the project does not control, pulled in by something the user never named.
				 */
				allowGit: "root",
			} satisfies Record<string, unknown>;
		},
		catch: (cause) =>
			Schema.is(InstallError)(cause)
				? cause
				: new InstallError({
						reason: "plugin-resolve-failed",
						reference,
						message: `cannot load npm configuration from ${dir}`,
						cause,
					}),
	});

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/** Stable, credential-free registry identity used to address registry artifacts in the store. */
export const registry = Effect.fn("PluginNpm.registry")(function* (
	target: Extract<Fetchable, { readonly kind: "registry" }>,
	cache: string,
	from: string,
) {
	const flat = yield* options(from, cache, target.spec);
	const scope = target.name.startsWith("@") ? target.name.slice(0, target.name.indexOf("/")) : undefined;
	const configured = (scope === undefined ? undefined : flat[`${scope}:registry`]) ?? flat.registry ?? PUBLIC_REGISTRY;
	if (typeof configured !== "string") {
		return yield* new InstallError({
			reason: "plugin-resolve-failed",
			reference: target.spec,
			message: `npm registry for ${target.name} is not a URL`,
		});
	}
	return yield* Effect.try({
		try: () => {
			const value = new URL(configured);
			value.username = "";
			value.password = "";
			value.hash = "";
			return value.href;
		},
		catch: (cause) =>
			new InstallError({
				reason: "plugin-resolve-failed",
				reference: target.spec,
				message: `npm registry for ${target.name} is not a valid URL: ${configured}`,
				cause,
			}),
	});
});

/** A 40- or 64-hex commit out of the `resolved` URL arborist writes into the lockfile. */
const commitIn = (resolved: string | undefined): string | undefined =>
	resolved?.match(/#([a-f0-9]{40}|[a-f0-9]{64})(?=::|$)/i)?.[1];

/**
 * The commit a git install actually landed on, read back from the lockfile arborist wrote.
 *
 * Both spellings are tried because which one exists depends on whether the tree was saved.
 */
const commit = Effect.fn("PluginNpm.commit")(function* (root: string, name: string) {
	for (const file of [path.join(root, "package-lock.json"), path.join(root, "node_modules", ".package-lock.json")]) {
		const parsed = yield* fs
			.readFileString(file)
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Lockfile))), Effect.option);
		if (Option.isNone(parsed)) continue;
		const found = commitIn(parsed.value.packages?.[`node_modules/${name}`]?.resolved);
		if (found !== undefined) return found;
	}
	return undefined;
});

/** Node error codes that mean "nothing here", as opposed to "this package is broken". */
const notFound = new Set([
	"ENOENT",
	"ENOTDIR",
	"MODULE_NOT_FOUND",
	"ERR_MODULE_NOT_FOUND",
	"ERR_PACKAGE_PATH_NOT_EXPORTED",
	"ERR_UNSUPPORTED_DIR_IMPORT",
]);

/**
 * The module to import out of an installed package.
 *
 * Ordered subpaths through the package's own `exports`, so a package that publishes a dedicated
 * `./plugin` entry is honoured and one that does not falls back to its main.
 *
 * Only "not found" is tolerated. Swallowing every error would turn a package that is broken --
 * a syntax error in its manifest, a permission problem -- into "no entrypoint", which is the
 * wrong diagnosis in the one place a person needs the right one.
 */
export const entrypoint = (directory: string, name?: string): Effect.Effect<string, InstallError> =>
	Effect.gen(function* () {
		for (const subpath of ["", "plugin"]) {
			const specifier =
				name === undefined ? path.join(directory, subpath === "" ? "index" : subpath) : path.join(name, subpath);
			const resolved = yield* Effect.try(() => resolveModule(specifier, directory)).pipe(
				Effect.asSome,
				Effect.catchIf(
					(error) => notFound.has(String((error.cause as { code?: unknown } | undefined)?.code)),
					() => Effect.succeed(Option.none<string>()),
				),
				Effect.mapError(
					(error) =>
						new InstallError({
							reason: "plugin-no-entrypoint",
							reference: name ?? directory,
							message: `cannot resolve an entrypoint in ${directory}`,
							cause: error,
						}),
				),
			);
			if (Option.isSome(resolved)) return fileURLToPath(resolved.value);
		}
		return yield* new InstallError({
			reason: "plugin-no-entrypoint",
			reference: name ?? directory,
			message: `no plugin entrypoint in ${directory}`,
		});
	});

/** The shape of arborist's tree that this module reads. Narrower than the library's own. */
interface Tree {
	readonly edgesOut: Map<string, { readonly to?: { readonly name: string; readonly path: string } }>;
}

/**
 * Runs the install into a directory. Injectable so tests can hand over a fixture instead of
 * reaching the network -- the one seam in this module.
 */
export type Runner = (input: {
	readonly target: Fetchable;
	readonly into: string;
	readonly cache: string;
	/** Where the `.npmrc` chain is read from: the host directory, never `into`. */
	readonly from: string;
}) => Effect.Effect<Tree, InstallError>;

export const reify: Runner = Effect.fn("PluginNpm.reify")(function* ({ target, into, cache, from }) {
	const flat = yield* options(from, cache, target.spec);
	const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"));
	const settings = {
		...flat,
		// Re-resolve rather than reuse a version that merely satisfies the range, because a
		// mutable target is being installed precisely to find out what it points at now.
		...(target.mutable ? { preferOnline: true, noGitRevCache: true } : {}),
		// Arborist waits on an audit report before completing an install, and we never read one.
		audit: false,
	};
	const arborist = new Arborist({
		...settings,
		path: into,
		binLinks: true,
		progress: false,
		savePrefix: "",
		// A lifecycle script runs before anyone decided to trust this package. Enforced here
		// rather than requested of a binary that may or may not honour the flag.
		ignoreScripts: true,
	});
	return yield* Effect.tryPromise({
		try: () =>
			arborist.reify({ ...settings, add: [target.spec], update: target.mutable, save: true, saveType: "prod" }),
		catch: (cause) =>
			new InstallError({
				reason: "plugin-fetch-failed",
				reference: target.spec,
				message: `cannot install ${target.spec}`,
				cause,
			}),
	}) as Effect.Effect<Tree, InstallError>;
});

/**
 * Fill `into` with the package `target` names, and report what landed there.
 *
 * A local target downloads nothing: the files on disk are already the answer, and a local plugin
 * is never copied into the store.
 */
export const download = Effect.fn("PluginNpm.download")(function* (input: {
	readonly target: Target;
	/** The staging directory the package is installed into. */
	readonly into: string;
	readonly cache: string;
	/** The host directory whose `.npmrc` chain governs this install. */
	readonly from: string;
	readonly runner?: Runner;
}) {
	const { target, into, cache, from, runner = reify } = input;
	if (target.kind === "local") {
		return {
			directory: target.path,
			name: path.basename(target.path),
			entrypoint: yield* entrypoint(target.path),
		} satisfies Fetched;
	}

	/*
	 * Arborist is given the *real* path, always.
	 *
	 * On macOS a temp directory is handed out as `/var/...` while its real location is
	 * `/private/var/...`. Reify through the symlinked spelling and the tree it returns has no root
	 * edges at all -- the installed package lands on disk, but `edgesOut` is empty and the
	 * lockfile keys come out as `../../…` paths that no commit can be recovered from. Nothing
	 * errors; the install simply reports that it installed nothing.
	 */
	const root = yield* fs.realPath(into).pipe(
		Effect.mapError(
			(cause) =>
				new InstallError({
					reason: "plugin-fetch-failed",
					reference: target.spec,
					message: `cannot resolve the staging directory ${into}`,
					cause,
				}),
		),
	);
	const tree = yield* runner({ target, into: root, cache, from });
	// What was actually added, named by the tree rather than inferred from the spec.
	const node = tree.edgesOut.values().next().value?.to;
	if (node === undefined) {
		return yield* new InstallError({
			reason: "plugin-fetch-failed",
			reference: target.spec,
			message: `${target.spec} installed nothing`,
		});
	}
	const manifest = yield* fs
		.readFileString(path.join(node.path, "package.json"))
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))), Effect.option);
	const version = Option.isNone(manifest) ? undefined : manifest.value.version;

	/*
	 * A git revision is the commit, never the branch name and never a fallback to the manifest
	 * version. Falling back is worse than failing, because it breaks updates unrecoverably: a
	 * branch that moves without bumping `package.json` would have `probe` return the new SHA and
	 * `download` return the unchanged version, so `add` compares version to version and discards
	 * the bytes it just fetched. "update available" forever, never applied.
	 */
	const revision =
		target.kind === "registry" ? version : ((yield* commit(root, node.name)) ?? (yield* noCommit(target.spec)));

	return {
		directory: node.path,
		name: node.name,
		...(version === undefined ? {} : { version }),
		...(revision === undefined ? {} : { revision }),
		entrypoint: yield* entrypoint(node.path, node.name),
	} satisfies Fetched;
});

const noCommit = (spec: string) =>
	new InstallError({
		reason: "plugin-no-commit",
		reference: spec,
		message: `cannot resolve a commit for ${spec}`,
	});

/**
 * What a mutable target points at right now, without installing it.
 *
 * `preferOnline` and `noGitRevCache` are the whole point: without them pacote answers from its own
 * metadata cache, and a staleness check that reads a cache is not a staleness check. An immutable
 * target skips the call entirely -- a version and a SHA cannot move.
 */
export const probe = Effect.fn("PluginNpm.probe")(function* (target: Target, cache: string, from: string) {
	if (target.kind === "local" || !target.mutable) return undefined;
	// The same chain the install will use. A probe that reads a different `.npmrc` answers about a
	// different registry than the one `update` then fetches from.
	const flat = yield* options(from, cache);
	// `_isRoot` is what `allowGit: "root"` keys on: this spec is the one the person asked about,
	// not a dependency of something else.
	const opts = { ...flat, preferOnline: true, noGitRevCache: true, _isRoot: true };
	const pacote = yield* Effect.promise(() => import("pacote"));
	return yield* Effect.tryPromise({
		try: async () =>
			target.kind === "registry"
				? (await pacote.manifest(target.spec, opts)).version
				: commitIn(await pacote.resolve(target.spec, opts)),
		catch: (cause) =>
			new InstallError({
				reason: "plugin-resolve-failed",
				reference: target.spec,
				message: `cannot reach ${target.spec}`,
				cause,
			}),
	});
});

/** A `file:` URL for an entrypoint, which is what the module loader takes. */
export const url = (entrypoint: string): string => pathToFileURL(entrypoint).href;

export * as PluginNpm from "./npm.ts";
