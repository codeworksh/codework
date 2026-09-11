import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
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
	return { name: parsed.name, spec: `${parsed.name}@${parsed.raw === parsed.name ? "latest" : parsed.rawSpec}` };
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
	Effect.mapError((cause) => new InstallError({ cause })),
);

const lock = Effect.fn("PluginPackage.lock")(function* (directory: string) {
	while (true) {
		const acquired = yield* Effect.acquireRelease(
			fs.makeDirectory(directory).pipe(
				Effect.as(true),
				Effect.catch((error) =>
					error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
				),
			),
			(acquired) => (acquired ? fs.remove(directory, { recursive: true }).pipe(Effect.orDie) : Effect.void),
		);
		if (acquired) return;
		yield* Effect.sleep("50 millis");
	}
});

export const install = Effect.fn("PluginPackage.install")(
	function* (request: Request, cache: string, runner: Runner = run) {
		const root = path.join(cache, "plugins");
		const key = createHash("sha256").update(request.spec).digest("hex");
		const directory = path.join(root, key);
		const marker = path.join(directory, ".complete.json");
		yield* fs.makeDirectory(root, { recursive: true });
		// mkdir is atomic across processes; scoped release also runs on interruption.
		yield* lock(`${directory}.lock`);
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
			yield* fs.writeFileString(
				path.join(staging, ".complete.json"),
				yield* Schema.encodeEffect(Schema.fromJsonString(Cached))({
					spec: request.spec,
					version: installed.version,
					entrypoint: path.relative(staging, fileURLToPath(entrypoint)),
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
	Effect.mapError((cause) => new InstallError({ cause })),
);
