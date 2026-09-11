import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Duration, Effect, Layer, Ref, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolve } from "import-meta-resolve";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import npa from "npm-package-arg";
import { fileSystem as fs, hostPath as path } from "../host.ts";

export interface Request {
	readonly name: string;
	readonly spec: string;
}

export const parse = (source: string): Request => {
	const parsed = npa(source);
	if (!parsed.name || !["version", "range", "tag"].includes(parsed.type)) {
		throw new Error(`Unsupported plugin package source: ${source}`);
	}
	// npa turns a trailing bare `@` into the `*` range, which would give "no version" a second
	// cache key. An explicit `plugin@*` keeps its own meaning.
	const omitted = parsed.raw === parsed.name || parsed.raw === `${parsed.name}@`;
	return { name: parsed.name, spec: `${parsed.name}@${omitted ? "latest" : parsed.rawSpec}` };
};

const Manifest = Schema.Struct({ version: Schema.String });
const Cached = Schema.Struct({ version: Schema.String, spec: Schema.String, entrypoint: Schema.String });

export interface Installed {
	readonly url: string;
	readonly version: string;
}

/** Runs inside the isolated staging directory. Override only for deterministic tests. */
export class InstallError extends Schema.TaggedError<InstallError>()("PluginInstallError", {
	cause: Schema.Defect(),
}) {}
export type Runner = (request: Request, directory: string) => Effect.Effect<void, InstallError>;

const run: Runner = Effect.fn("PluginPackage.run")(
	function* (request, directory) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const process = yield* spawner.spawn(
			ChildProcess.make("pnpm", ["add", "--ignore-scripts", "--ignore-workspace", "--save-exact", request.spec], {
				cwd: directory,
				stdout: "ignore",
				stderr: "inherit",
			}),
		);
		const code = yield* process.exitCode;
		if (code !== 0)
			return yield* new InstallError({ cause: new Error(`pnpm installation failed with exit code ${code}`) });
	},
	Effect.scoped,
	Effect.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))),
	Effect.mapError((cause) => (Schema.is(InstallError)(cause) ? cause : new InstallError({ cause }))),
);

/** How long to wait for another installer of the same spec before giving up. */
const LOCK_TIMEOUT = Duration.minutes(2);

/**
 * Claims `directory` by creating it, polling while another process holds it.
 *
 * One finalizer for the whole wait, registered before the first attempt: retrying inside
 * `acquireRelease` would add a finalizer per poll. A crashed installer leaves its lock
 * behind, so the wait is bounded rather than infinite.
 */
const lock = Effect.fn("PluginPackage.lock")(function* (directory: string) {
	const held = yield* Ref.make(false);
	yield* Effect.acquireRelease(Effect.void, () =>
		Ref.get(held).pipe(
			Effect.flatMap((owned) => (owned ? fs.remove(directory, { recursive: true, force: true }) : Effect.void)),
			Effect.orDie,
		),
	);
	const acquired = yield* fs.makeDirectory(directory).pipe(
		Effect.as(true),
		Effect.catch((error) => (error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error))),
		Effect.tap((owned) => (owned ? Ref.set(held, true) : Effect.void)),
		Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (owned) => owned }),
		Effect.timeout(LOCK_TIMEOUT),
		Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
	);
	if (!acquired)
		return yield* new InstallError({
			cause: new Error(`Timed out waiting for another plugin installation to release ${directory}`),
		});
});

export const install = Effect.fn("PluginPackage.install")(
	function* (request: Request, cache: string, runner: Runner = run) {
		const root = path.join(cache, "plugins");
		const key = createHash("sha256").update(request.spec).digest("hex");
		const directory = path.join(root, key);
		const marker = path.join(directory, ".complete.json");
		yield* fs.makeDirectory(root, { recursive: true });
		// A published entry is immutable, so reading one never contends with an installer.
		// mkdir is atomic across processes; the scoped release also runs on interruption.
		if (!(yield* fs.exists(marker))) yield* lock(`${directory}.lock`);
		// Re-check under the lock: the installer we waited for may have just published.
		if (!(yield* fs.exists(marker))) {
			const staging = yield* Effect.acquireRelease(
				fs.makeTempDirectory({ directory: root, prefix: `${key}-` }),
				(staging) => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.orDie),
			);
			yield* fs.writeFileString(path.join(staging, "package.json"), '{"private":true,"type":"module"}');
			yield* runner(request, staging);
			const manifest = yield* fs.readFileString(path.join(staging, "node_modules", request.name, "package.json"));
			const installed = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(manifest);
			// Validate root resolution before marking this installation complete.
			const entrypoint = yield* Effect.try(() =>
				resolve(request.name, pathToFileURL(path.join(staging, "package.json")).href),
			);
			// `resolve` realpaths its answer while `makeTempDirectory` does not, so relate the
			// two through the realpath or a symlinked cache root escapes the published entry.
			const entry = path.relative(yield* fs.realPath(staging), fileURLToPath(entrypoint));
			if (entry.startsWith("..") || path.isAbsolute(entry))
				return yield* new InstallError({
					cause: new Error(`Plugin entrypoint escapes its installation: ${entry}`),
				});
			yield* fs.writeFileString(
				path.join(staging, ".complete.json"),
				yield* Schema.encodeEffect(Schema.fromJsonString(Cached))({
					spec: request.spec,
					version: installed.version,
					entrypoint: entry,
				}),
			);
			if (yield* fs.exists(directory)) yield* fs.remove(directory, { recursive: true });
			yield* fs.rename(staging, directory);
		}
		const saved = yield* fs
			.readFileString(marker)
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cached))));
		if (saved.spec !== request.spec)
			return yield* new InstallError({ cause: new Error("Plugin package cache request mismatch") });
		const url = pathToFileURL(path.resolve(directory, saved.entrypoint)).href;
		return { url, version: saved.version } satisfies Installed;
	},
	Effect.scoped,
	Effect.mapError((cause) => (Schema.is(InstallError)(cause) ? cause : new InstallError({ cause }))),
);
