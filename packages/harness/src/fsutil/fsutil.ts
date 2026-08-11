import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Layer, FileSystem as PlatformFileSystem, Schema } from "effect";
import { posix } from "node:path";

/**
 * Host-side filesystem helpers over `@effect/platform`, for the machine the
 * harness itself runs on — config, caches, and anything else outside a
 * workspace.
 *
 * This is **not** the runtime filesystem. Anything touching a project's files
 * goes through `SandboxFileSystem`, which may be local or remote; reaching for
 * this service instead would silently pin that work to the harness's own disk.
 */

export class FileSystemError extends Schema.TaggedError<FileSystemError>()("FileSystemError", {
	method: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly readFileString: (path: string, encoding?: string) => Effect.Effect<string, FileSystemError>;
	readonly writeFileString: (path: string, data: string) => Effect.Effect<void, FileSystemError>;
	readonly isDir: (path: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/fsutil/fsutil/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* PlatformFileSystem.FileSystem;

		const exists = Effect.fn("FSUtil.exists")(function* (path: string) {
			return yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		});

		const readFileString = Effect.fn("FSUtil.readFileString")(function* (path: string, encoding = "utf8") {
			return yield* fs
				.readFileString(path, encoding)
				.pipe(Effect.mapError((cause) => new FileSystemError({ method: "readFileString", cause })));
		});

		const writeFileString = Effect.fn("FSUtil.writeFileString")(function* (path: string, data: string) {
			return yield* fs.writeFileString(path, data).pipe(
				Effect.catch(() =>
					fs
						.makeDirectory(posix.dirname(path), { recursive: true })
						.pipe(Effect.flatMap(() => fs.writeFileString(path, data))),
				),
				Effect.mapError((cause) => new FileSystemError({ method: "writeFileString", cause })),
			);
		});

		const isDir = Effect.fn("FSUtil.isDir")(function* (path: string) {
			return yield* fs.stat(path).pipe(
				Effect.map((stat) => stat.type === "Directory"),
				Effect.catch(() => Effect.succeed(false)),
			);
		});

		return Service.of({
			exists,
			readFileString,
			writeFileString,
			isDir,
		});
	}),
);

export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer));

export * as FSUtil from "./fsutil.ts";
