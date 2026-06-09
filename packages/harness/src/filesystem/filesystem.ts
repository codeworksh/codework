import { create, RealFSProvider, type VirtualFileSystem } from "@platformatic/vfs";
import { Context, Effect, Layer, Schema } from "effect";

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
	method: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly isDir: (path: string) => Effect.Effect<boolean>;
	readonly readFileString: (path: string, encoding?: string) => Effect.Effect<string, FileSystemError>;
	readonly writeFileString: (path: string, data: string) => Effect.Effect<void, FileSystemError>;
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

		const writeFileString = Effect.fn("FileSystem.writeFileString")(function* (path: string, data: string) {
			return yield* Effect.tryPromise({
				try: () => vfs.promises.writeFile(path, data),
				catch: (cause) => new FileSystemError({ method: "writeFileString", cause }),
			});
		});

		const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
			const stat = yield* Effect.tryPromise({
				try: () => vfs.promises.stat(path),
				catch: (cause) => new FileSystemError({ method: "isDir", cause }),
			}).pipe(Effect.catch(() => Effect.succeed(undefined)));

			return stat?.isDirectory() ?? false;
		});

		return Service.of({
			isDir,
			readFileString,
			writeFileString,
		});
	}),
);

export const layerFromVfs = (vfs: VirtualFileSystem) => Layer.succeed(Vfs, vfs);

export const NodeFileSystem = {
	layer: (rootPath: string) =>
		layerFromVfs(
			create(new RealFSProvider(rootPath), {
				moduleHooks: false,
			}),
		),
} as const;

export const defaultLayer = (rootPath: string) => layer.pipe(Layer.provide(NodeFileSystem.layer(rootPath)));

export * as FileSystem from "./filesystem";
