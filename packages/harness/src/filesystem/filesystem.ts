import { Effect, Schema, Context, Layer } from "effect";

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
	method: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly readFileString: (path: string, encoding?: string) => Effect.Effect<string, FileSystemError>;
	readonly writeFileString: (path: string, data: string) => Effect.Effect<void, FileSystemError>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/filesystem") {}

export const layer = Layer.effect(Service);
