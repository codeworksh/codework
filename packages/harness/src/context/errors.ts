import { Schema } from "effect";

export class ContextDecodeError extends Schema.TaggedError<ContextDecodeError>()("ContextDecodeError", {
	entryId: Schema.String,
	type: Schema.String,
	reason: Schema.String,
}) {}

export class ContextEncodeError extends Schema.TaggedError<ContextEncodeError>()("ContextEncodeError", {
	messageId: Schema.String,
	role: Schema.String,
	reason: Schema.String,
}) {}
