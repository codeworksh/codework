import { Message, validateSchema } from "@codeworksh/aikit";
import { Effect, Schema, type SchemaAST, SchemaGetter, SchemaIssue } from "effect";
import Value from "typebox/value";
import { uuidv7 } from "uuidv7";
import { optional, withStatics } from "../schema.ts";

type AikitAssistantPart = Message.AssistantMessage["parts"][number];

/** Undeclared fields used only while aikit is assembling a streamed part. */
const aikitTransientFields: Readonly<Record<AikitAssistantPart["type"], ReadonlyArray<string>>> = {
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

const canonicalizeAikitAssistantMessage = (message: Message.AssistantMessage): Message.AssistantMessage => ({
	...message,
	parts: message.parts.map((part) => omit(part, aikitTransientFields[part.type])),
});

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const validateAikitAssistantMessage = (value: unknown, options: SchemaAST.ParseOptions) =>
	Effect.try({
		try: () =>
			canonicalizeAikitAssistantMessage(
				validateSchema(Message.AssistantMessageSchema, value, "aikit assistant message"),
			),
		catch: (cause) => new SchemaIssue.InvalidValue({ message: reasonOf(cause) }, value, options),
	});

const aikitAssistantMessageDeclared = Schema.declare<Message.AssistantMessage>(
	(value): value is Message.AssistantMessage => Value.Check(Message.AssistantMessageSchema, value),
	{ expected: "aikit AssistantMessage" },
);

/**
 * Effect Schema adapter for aikit's TypeBox assistant message. Durable LLM
 * events use it to validate their payload and strip streaming-only fields.
 */
export const AikitAssistantMessage = Schema.Unknown.pipe(
	Schema.decodeTo(aikitAssistantMessageDeclared, {
		decode: SchemaGetter.transformOrFail(validateAikitAssistantMessage),
		encode: SchemaGetter.transformOrFail(validateAikitAssistantMessage),
	}),
);
export type AikitAssistantMessage = typeof AikitAssistantMessage.Type;

export const ID = Schema.String.pipe(
	Schema.brand("Event.ID"),
	withStatics((schema) => ({
		create: () => schema.make(`evt_${uuidv7()}`),
	})),
);
export type ID = typeof ID.Type;

export type Definition<
	Type extends string = string,
	DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
	readonly type: Type;
	readonly durable?: {
		readonly version: number; // event versioning for decoding in later time
		readonly aggregate: string;
	};
	readonly data: DataSchema;
};

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>;

export type Payload<D extends Definition = Definition> = {
	readonly id: ID;
	readonly type: D["type"];
	readonly data: Data<D>;
	readonly durable?: {
		readonly aggregateId: string;
		readonly seq: number;
		readonly version: number;
	};
	readonly metadata?: Record<string, string>;
};

export function define<
	const Type extends string,
	const Fields extends Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>,
>(input: {
	readonly type: Type;
	readonly durable?: {
		readonly version: number;
		readonly aggregate: string;
	};
	readonly schema: Fields;
}) {
	const data = Schema.Struct(input.schema);
	return Schema.Struct({
		id: ID,
		metadata: optional(Schema.Record(Schema.String, Schema.String)),
		type: Schema.Literal(input.type),
		durable: optional(Schema.Struct({ aggregateId: Schema.String, seq: Schema.Int, version: Schema.Int })),
		data,
	})
		.annotate({ identifier: input.type })
		.pipe(
			withStatics(() => ({
				type: input.type,
				...(input.durable === undefined ? {} : { durable: input.durable }),
				data,
			})),
		) satisfies Definition<Type, typeof data>;
}

// Register all the event definitions.
export function inventory<const Definitions extends ReadonlyArray<Definition>>(...definitions: Definitions) {
	return Object.freeze(definitions);
}

export function versionedType(type: string, version: number) {
	return `${type}.${version}`;
}

export function durable<const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) {
	return readonlyMap(
		definitions.reduce((result, definition) => {
			if (!definition.durable) return result;
			const key = versionedType(definition.type, definition.durable.version);
			if (result.has(key)) throw new Error(`Duplicate durable event definition for ${key}`);
			result.set(key, definition);
			return result;
		}, new Map<string, Definitions[number]>()),
	);
}

function readonlyMap<Key, Value>(map: Map<Key, Value>): ReadonlyMap<Key, Value> {
	const result: ReadonlyMap<Key, Value> = Object.freeze({
		get size() {
			return map.size;
		},
		entries: () => map.entries(),
		forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
			map.forEach((value, key) => callback.call(thisArg, value, key, result)),
		get: (key: Key) => map.get(key),
		has: (key: Key) => map.has(key),
		keys: () => map.keys(),
		values: () => map.values(),
		[Symbol.iterator]: () => map[Symbol.iterator](),
	});
	return result;
}

export function latest(definitions: ReadonlyArray<Definition>) {
	return readonlyMap(
		definitions.reduce((result, definition) => {
			const existing = result.get(definition.type);
			if (!existing) {
				result.set(definition.type, definition);
				return result;
			}
			if (definition.durable && existing.durable && definition.durable.version !== existing.durable.version) {
				if (definition.durable.version > existing.durable.version) result.set(definition.type, definition);
				return result;
			}
			if (definition !== existing) throw new Error(`Duplicate latest event definition for ${definition.type}`);
			return result;
		}, new Map<string, Definition>()),
	);
}

export * as EventSchema from "./schema.ts";
