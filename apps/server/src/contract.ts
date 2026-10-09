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

/** A conversation with the agent, as listed under its project. */
export const SessionSummary = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	/** Last activity, epoch milliseconds. */
	updated: Schema.Number,
});
export type SessionSummary = typeof SessionSummary.Type;

export const Project = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	path: Schema.String,
	sessions: Schema.Array(SessionSummary),
});
export type Project = typeof Project.Type;

export const Message = Schema.Struct({
	role: Schema.Literals(["user", "assistant"]),
	text: Schema.String,
});
export type Message = typeof Message.Type;

export const Session = Schema.Struct({
	...SessionSummary.fields,
	project: Schema.String,
	messages: Schema.Array(Message),
});
export type Session = typeof Session.Type;

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("Server.SessionNotFound", {
	id: Schema.String,
}) {}

/** Package-scoped JSON storage: `package` namespaces keys so packages never collide. */
const KvKey = { package: Schema.String, key: Schema.String };

export const Api = RpcGroup.make(
	Rpc.make("fs.list", {
		payload: { path: Schema.String },
		success: Schema.Array(Entry),
		error: FsError,
	}),
	Rpc.make("projects.list", {
		success: Schema.Array(Project),
	}),
	Rpc.make("sessions.get", {
		payload: { id: Schema.String },
		success: Session,
		error: SessionNotFound,
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
