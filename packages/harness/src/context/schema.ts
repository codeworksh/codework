/**
 * Effect Schema adapter over aikit's TypeBox schemas, so an aikit value can be a
 * field in `EventSchema.define({ schema: { ... } })`.
 *
 * Context owns the aikit boundary, and `codec.ts` next door already bridges the
 * same way for stored messages -- both go through aikit's own `validateSchema`
 * rather than mirroring its shapes in Effect, so there is one definition of what
 * an aikit message is and no drift to keep in sync.
 *
 * Keep this a leaf: `@codeworksh/aikit` and `effect` only, nothing else in
 * `src`. `event/list.ts` imports it, so reaching back into `src/event` or
 * `src/session` from here would close a cycle.
 */

import { Message, validateSchema } from "@codeworksh/aikit";
import { Effect, Schema, type SchemaAST, SchemaGetter, SchemaIssue } from "effect";
import Value from "typebox/value";

type Part = Message.AssistantMessage["parts"][number];

/**
 * Undeclared bookkeeping aikit's streaming loop hangs off a part while a
 * response is in flight. TypeBox objects are open, so validation alone keeps
 * them; aikit deletes them itself once a block finishes (`llm/stream.ts`), but
 * a stream that ends abruptly can leave them behind. Neither may reach the
 * durable event log or a projection.
 *
 * Only undeclared fields belong here. `partial` on a running tool call is a
 * declared member of `ToolCallRunningPartSchema`, so it stays: this codec is
 * storage-faithful and does not prune parts aikit's own schema admits. Whether
 * mid-run progress should be durable is a decision for the tool-call slice, not
 * something to settle silently here.
 */
const TRANSIENT: Readonly<Record<Part["type"], ReadonlyArray<string>>> = {
	text: ["streamId"],
	image: [],
	thinking: ["streamId"],
	toolCall: ["partialJson"],
};

const omit = <T extends object>(value: T, keys: ReadonlyArray<string>): T => {
	if (!keys.some((key) => key in value)) return value;
	const copy = { ...value } as T & Record<string, unknown>;
	for (const key of keys) delete copy[key];
	return copy;
};

/** Drop every transient streaming field, leaving the durable message. */
export const canonicalize = (message: Message.AssistantMessage): Message.AssistantMessage => ({
	...message,
	parts: message.parts.map((part) => omit(part, TRANSIENT[part.type])),
});

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Validate through aikit's own validator, then canonicalize. Used in both
 * directions: decode guards what we read back, encode guards what we write.
 */
const validate = (value: unknown, options: SchemaAST.ParseOptions) =>
	Effect.try({
		try: () => canonicalize(validateSchema(Message.AssistantMessageSchema, value, "aikit assistant message")),
		catch: (cause) => new SchemaIssue.InvalidValue({ message: reasonOf(cause) }, value, options),
	});

const Declared = Schema.declare<Message.AssistantMessage>(
	(value): value is Message.AssistantMessage => Value.Check(Message.AssistantMessageSchema, value),
	{ expected: "aikit AssistantMessage" },
);

/**
 * `Schema.Codec<Message.AssistantMessage, unknown>`. The message is already a
 * plain JSON object, so the encoded side is the same shape — the transformation
 * exists to validate and to strip transient fields, not to reshape.
 */
export const AssistantMessage = Schema.Unknown.pipe(
	Schema.decodeTo(Declared, {
		decode: SchemaGetter.transformOrFail(validate),
		encode: SchemaGetter.transformOrFail(validate),
	}),
);
export type AssistantMessage = typeof AssistantMessage.Type;

export * as ContextSchema from "./schema.ts";
