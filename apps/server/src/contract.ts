import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const EntryKind = Schema.Literals(["file", "directory"]);
export type EntryKind = typeof EntryKind.Type;

/** One direct child of a listed directory. */
export const Entry = Schema.Struct({ name: Schema.String, kind: EntryKind });
export type Entry = typeof Entry.Type;

export class FsError extends Schema.TaggedError<FsError>()("Server.FsError", {
	path: Schema.String,
	message: Schema.String,
}) {}

/** Package-scoped JSON storage: `package` namespaces keys so packages never collide. */
const KvKey = { package: Schema.String, key: Schema.String };

export const Api = RpcGroup.make(
	Rpc.make("fs.list", {
		payload: { path: Schema.String },
		success: Schema.Array(Entry),
		error: FsError,
	}),
	Rpc.make("kv.get", {
		payload: KvKey,
		success: Schema.OptionFromNullOr(Schema.Json),
	}),
	Rpc.make("kv.set", {
		payload: { ...KvKey, value: Schema.Json },
		success: Schema.Void,
	}),
);

export * as Contract from "./contract.ts";
