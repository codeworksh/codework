import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Layer, FileSystem as PlatformFileSystem, Schema } from "effect";
import { dirname, join } from "node:path";

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
	method: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly readFileString: (path: string, encoding?: string) => Effect.Effect<string, FileSystemError>;
	readonly writeFileString: (path: string, data: string) => Effect.Effect<void, FileSystemError>;
	readonly isDir: (path: string) => Effect.Effect<boolean>;
	readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[]>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/filesystem") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* PlatformFileSystem.FileSystem;

		const exists = Effect.fn("FileSystem.exists")(function* (path: string) {
			return yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		});

		const readFileString = Effect.fn("FileSystem.readFileString")(function* (path: string, encoding = "utf8") {
			return yield* fs
				.readFileString(path, encoding)
				.pipe(Effect.mapError((cause) => new FileSystemError({ method: "readFileString", cause })));
		});

		const writeFileString = Effect.fn("FileSystem.writeFileString")(function* (path: string, data: string) {
			return yield* fs.writeFileString(path, data).pipe(
				Effect.catch(() =>
					fs
						.makeDirectory(dirname(path), { recursive: true })
						.pipe(Effect.flatMap(() => fs.writeFileString(path, data))),
				),
				Effect.mapError((cause) => new FileSystemError({ method: "writeFileString", cause })),
			);
		});

		const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
			return yield* fs.stat(path).pipe(
				Effect.map((stat) => stat.type === "Directory"),
				Effect.catch(() => Effect.succeed(false)),
			);
		});

		const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
			const result: string[] = [];
			let current = options.start;

			while (true) {
				for (const target of options.targets) {
					const search = join(current, target);
					if (yield* exists(search)) result.push(search);
				}

				if (options.stop === current) break;

				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}

			return result;
		});

		return Service.of({
			exists,
			readFileString,
			writeFileString,
			isDir,
			up,
		});
	}),
);

export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer));

export function windowsPath(p: string): string {
	if (process.platform !== "win32") return p;
	return p
		.replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		.replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		.replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		.replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`);
}

export * as FileSystem from "./filesystem";
