import { Schema } from "effect";
import { SandboxInstance } from "../sandbox/instance.ts";
import { AbsolutePath } from "../schema.ts";

const Fields = {
	directory: AbsolutePath,
	sandboxInstanceId: SandboxInstance.ID,
};

export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
	"Location.DirectoryNotFoundError",
	Fields,
) {}

export class NotDirectoryError extends Schema.TaggedError<NotDirectoryError>()("Location.NotDirectoryError", Fields) {}

export type Error = DirectoryNotFoundError | NotDirectoryError;
