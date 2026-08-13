/*
 * @file Turns durable session events into the entry appends they materialize.
 *
 * One place mapping event types to conversation rows,
 * so the projector stays wiring and the shape of a
 * persisted message lives somewhere a reader can find it.
 *
 * Two boundaries meet here. `Prompt` is what the caller asked for -- text now,
 * attachments later -- and is what the inbox stores. An entry holds the aikit
 * message envelope in `data` with its parts split into rows. The provider-facing
 * shape is a third thing again, built by the loop for one request and never
 * persisted.
 */

import { Message } from "@codeworksh/aikit";
import { DateTime } from "effect";
import type { Prompt } from "../prompt/schema.ts";
import type { AppendEntry } from "../session.ts";
import type { SessionSchema } from "../schema.ts";
import type { SessionMessageSchema } from "./schema.ts";

/**
 * The append a promoted prompt materializes.
 *
 * `id` is the input's id, not a fresh one: an input and the entry it becomes are
 * one identity in two lifecycle stages, which is what lets `projectAdmitted`
 * reject an id that has already graduated.
 *
 * `seq` is the promoting event's sequence, so an entry's position in the tree
 * and its position in the durable log are the same number.
 */
export const fromPrompt = (input: {
	readonly id: SessionMessageSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly seq: number;
	readonly prompt: Prompt;
	readonly timeCreated: DateTime.Utc;
}): AppendEntry => {
	// Built through aikit's own factory so the persisted envelope stays the
	// shape aikit reads back, rather than a hand-rolled lookalike.
	const message = Message.createUserMessage({
		messageId: input.id,
		role: "user",
		time: { created: DateTime.toEpochMillis(input.timeCreated) },
		parts: [{ type: "text", text: input.prompt.text }],
	});
	const { parts, ...envelope } = message;
	return {
		id: input.id,
		sessionId: input.sessionId,
		seq: input.seq,
		type: "user",
		data: JSON.stringify(envelope),
		parts: parts.map((part) => ({ type: part.type, data: JSON.stringify(part) })),
	};
};

export * as SessionMessageUpdater from "./updater.ts";
