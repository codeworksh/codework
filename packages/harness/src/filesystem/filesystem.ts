import type { VirtualFileSystem } from "@platformatic/vfs";
import { Context, Effect, Layer, Schema } from "effect";
import { dirname, join } from "path";

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
	method: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly isDir: (path: string) => Effect.Effect<boolean>;
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly readFileString: (path: string, encoding?: string) => Effect.Effect<string, FileSystemError>;
	readonly writeFileString: (path: string, data: string) => Effect.Effect<void, FileSystemError>;
	readonly up: (options: {
		targets: string[];
		start: string;
		stop?: string;
	}) => Effect.Effect<string[], FileSystemError>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/filesystem") {}

export class Vfs extends Context.Service<Vfs, VirtualFileSystem>()("@codework/filesystem/Vfs") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const vfs = yield* Vfs;

		const readFileString = Effect.fn("FileSystem.readFileString")(function* (path: string, encoding = "utf8") {
			return yield* Effect.tryPromise({
				try: () => vfs.promises.readFile(path, encoding as BufferEncoding),
				catch: (cause) => new FileSystemError({ method: "readFileString", cause }),
			});
		});

		// virtual providers create missing parents implicitly while the real
		// filesystem rejects them; mkdir first so every backend behaves the same
		const writeFileString = Effect.fn("FileSystem.writeFileString")(function* (path: string, data: string) {
			return yield* Effect.tryPromise({
				try: async () => {
					await vfs.promises.mkdir(dirname(path), { recursive: true });
					await vfs.promises.writeFile(path, data);
				},
				catch: (cause) => new FileSystemError({ method: "writeFileString", cause }),
			});
		});

		const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
			const stat = yield* Effect.tryPromise({
				try: () => vfs.promises.stat(path),
				catch: (cause) => new FileSystemError({ method: "isDir", cause }),
			}).pipe(Effect.catch(() => Effect.void));

			return stat?.isDirectory() ?? false;
		});

		const exists = Effect.fn("FileSystem.exists")(function* (path: string) {
			const exists = yield* Effect.tryPromise({
				try: () => vfs.provider.exists(path),
				catch: (cause) => new FileSystemError({ method: "exists", cause }),
			}).pipe(Effect.catch(() => Effect.void));

			return exists ?? false;
		});

		const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
			const result: string[] = [];
			let current = options.start;

			while (true) {
				for (const target of options.targets) {
					const search = join(current, target);
					const exists = yield* Effect.tryPromise({
						try: () => vfs.provider.exists(search),
						catch: (cause) => new FileSystemError({ method: "up", cause }),
					});

					if (exists) result.push(search);
				}

				if (options.stop === current) break;

				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}

			return result;
		});

		return Service.of({
			up,
			isDir,
			exists,
			readFileString,
			writeFileString,
		});
	}),
);

export const layerFromVfs = (vfs: VirtualFileSystem) => Layer.succeed(Vfs, vfs);

export function windowsPath(p: string): string {
	if (process.platform !== "win32") return p;
	return p
		.replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		.replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		.replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		.replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`);
}

export * as FileSystem from "./filesystem";
