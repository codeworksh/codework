import { create, RealFSProvider, type VirtualFileSystem } from "@platformatic/vfs";
import { Context, Effect, Layer, Schema } from "effect";

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
	method: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly readFileString: (path: string, encoding?: string) => Effect.Effect<string, FileSystemError>;
	readonly writeFileString: (path: string, data: string) => Effect.Effect<void, FileSystemError>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/filesystem") {}

export class Vfs extends Context.Service<Vfs, VirtualFileSystem>()("@codework/filesystem/Vfs") {}

const attempt = <A>(method: string, evaluate: () => Promise<A>) =>
	Effect.tryPromise({
		try: evaluate,
		catch: (cause) => new FileSystemError({ method, cause }),
	});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const vfs = yield* Vfs;

		return Service.of({
			readFileString: (path, encoding = "utf8") =>
				attempt("readFileString", () => vfs.promises.readFile(path, encoding as BufferEncoding)),
			writeFileString: (path, data) => attempt("writeFileString", () => vfs.promises.writeFile(path, data)),
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
