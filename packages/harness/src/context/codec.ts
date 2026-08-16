/*
 * @file Codec provides the wire codec schema b/w harness <-> aikit
 * Use helper functions to encode-decode payload over the wire.
 * */
import { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Option, Schema } from "effect";
import { validateAikitMessage, validateAikitUserMessage } from "../schema.ts";
import { SessionSchema } from "../session/schema.ts";
import type { Session } from "../session/session.ts";
import { ContextDecodeError, ContextEncodeError } from "./errors.ts";

export interface EncodedMessage {
	readonly type: "user" | "assistant";
	readonly data: string;
	readonly parts: ReadonlyArray<Session.AppendPart>;
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const decodeJsonObject = Schema.decodeUnknownEffect(SessionSchema.JsonObject);
const encodeJsonObject = Schema.encodeEffect(SessionSchema.JsonObject);

const parseJson = (data: string, entryId: string, type: string, subject: string) =>
	decodeJsonObject(data).pipe(
		Effect.mapError(
			(cause) =>
				new ContextDecodeError({
					entryId,
					type,
					reason: `${subject} is not valid JSON: ${reasonOf(cause)}`,
				}),
		),
	);

const validateDecoded = (
	value: unknown,
	entryId: string,
	type: string,
): Effect.Effect<Message.Message, ContextDecodeError> =>
	Effect.try({
		try: () => validateAikitMessage(value, `context entry ${entryId}`),
		catch: (cause) => new ContextDecodeError({ entryId, type, reason: reasonOf(cause) }),
	});

export const validateUserMessage = (
	value: unknown,
	entryId: string,
	type: string,
): Effect.Effect<Message.UserMessage, ContextDecodeError> =>
	Effect.try({
		try: () => validateAikitUserMessage(value, `context entry ${entryId}`),
		catch: (cause) => new ContextDecodeError({ entryId, type, reason: reasonOf(cause) }),
	});

export const encodeMessage = Effect.fn("Context.encodeMessage")(function* (
	message: Message.Message,
): Effect.fn.Return<EncodedMessage, ContextEncodeError> {
	const validated = yield* Effect.try({
		try: () => validateAikitMessage(message, `context message ${message.messageId}`),
		catch: (cause) =>
			new ContextEncodeError({
				messageId: message.messageId,
				role: message.role,
				reason: reasonOf(cause),
			}),
	});
	const { parts, ...envelope } = validated;
	const data = yield* encodeJsonObject(envelope).pipe(
		Effect.mapError(
			(cause) =>
				new ContextEncodeError({
					messageId: message.messageId,
					role: message.role,
					reason: cause.message,
				}),
		),
	);
	const encodedParts = yield* Effect.forEach(parts, (part) =>
		encodeJsonObject(part).pipe(
			Effect.map((data) => ({
				type: part.type,
				...(part.type === "toolCall" ? { status: part.status, callId: part.callID, toolName: part.name } : {}),
				data,
			})),
			Effect.mapError(
				(cause) =>
					new ContextEncodeError({
						messageId: message.messageId,
						role: message.role,
						reason: cause.message,
					}),
			),
		),
	);
	return {
		type: validated.role,
		data,
		parts: encodedParts,
	};
});

const decodeParts = Effect.fn("Context.decodeParts")(function* (
	hydrated: Session.HydratedEntry,
): Effect.fn.Return<ReadonlyArray<unknown>, ContextDecodeError> {
	const { entry } = hydrated;
	const sorted = [...hydrated.parts].sort((left, right) => left.partIndex - right.partIndex);
	const parts: unknown[] = [];
	for (const [index, row] of sorted.entries()) {
		if (row.entryId !== entry.id) {
			return yield* new ContextDecodeError({
				entryId: entry.id,
				type: entry.type,
				reason: `part ${index} belongs to entry ${row.entryId}`,
			});
		}
		if (row.partIndex !== index) {
			return yield* new ContextDecodeError({
				entryId: entry.id,
				type: entry.type,
				reason: `part indexes must be dense from 0; expected ${index}, received ${row.partIndex}`,
			});
		}
		const part = yield* parseJson(row.data, entry.id, entry.type, `part ${index}`);
		if (typeof part !== "object" || part === null || !("type" in part) || part.type !== row.type) {
			return yield* new ContextDecodeError({
				entryId: entry.id,
				type: entry.type,
				reason: `part ${index} type does not match promoted type "${row.type}"`,
			});
		}
		if (row.type === "toolCall") {
			const promotedStatus = Option.getOrUndefined(row.status);
			const promotedCallId = Option.getOrUndefined(row.callId);
			const promotedToolName = Option.getOrUndefined(row.toolName);
			if (
				!("status" in part) ||
				part.status !== promotedStatus ||
				!("callID" in part) ||
				part.callID !== promotedCallId ||
				!("name" in part) ||
				part.name !== promotedToolName
			) {
				return yield* new ContextDecodeError({
					entryId: entry.id,
					type: entry.type,
					reason: `part ${index} tool columns do not match its authoritative JSON`,
				});
			}
		} else if (Option.isSome(row.status) || Option.isSome(row.callId) || Option.isSome(row.toolName)) {
			return yield* new ContextDecodeError({
				entryId: entry.id,
				type: entry.type,
				reason: `part ${index} type "${row.type}" must not carry promoted tool columns`,
			});
		}
		parts.push(part);
	}
	return parts;
});

export const decodeSyntheticMessage = Effect.fn("Context.decodeSyntheticMessage")(function* (
	hydrated: Session.HydratedEntry,
): Effect.fn.Return<Message.UserMessage, ContextDecodeError> {
	const { entry } = hydrated;
	const parts = yield* decodeParts(hydrated);
	return yield* validateUserMessage(
		{
			messageId: entry.id,
			role: "user",
			time: { created: DateTime.toEpochMillis(entry.createdAt) },
			parts,
		},
		entry.id,
		entry.type,
	);
});

export const decodeMessage = Effect.fn("Context.decodeMessage")(function* (
	hydrated: Session.HydratedEntry,
): Effect.fn.Return<Message.Message, ContextDecodeError> {
	const { entry } = hydrated;
	if (entry.type !== "user" && entry.type !== "assistant") {
		return yield* new ContextDecodeError({
			entryId: entry.id,
			type: entry.type,
			reason: "only user and assistant entries contain complete aikit messages",
		});
	}

	const envelope = yield* parseJson(entry.data, entry.id, entry.type, "message envelope");
	const parts = yield* decodeParts(hydrated);

	const message = yield* validateDecoded({ ...(envelope as Record<string, unknown>), parts }, entry.id, entry.type);
	if (message.messageId !== entry.id) {
		return yield* new ContextDecodeError({
			entryId: entry.id,
			type: entry.type,
			reason: `messageId "${message.messageId}" does not match entry id`,
		});
	}
	if (message.role !== entry.type) {
		return yield* new ContextDecodeError({
			entryId: entry.id,
			type: entry.type,
			reason: `message role "${message.role}" does not match entry type`,
		});
	}
	return message;
});

export * as ContextCodec from "./codec.ts";
