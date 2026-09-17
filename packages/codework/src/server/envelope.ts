import { EventList, EventSchema, optional } from "@codeworksh/harness/effect";
import { Effect, Schema } from "effect";

/**
 * The wire form of an `EventSchema.Payload`. `data` is carried in its encoded
 * form — decoded payloads are not wire-safe (`Schema.Duration`, aikit class
 * transforms) — so clients decode it lazily through their own copy of the
 * registry and can skip types they do not know.
 */
export const EventEnvelope = Schema.Struct({
	id: EventSchema.ID,
	type: Schema.String,
	durable: optional(Schema.Struct({ aggregateId: Schema.String, seq: Schema.Int, version: Schema.Int })),
	metadata: optional(Schema.Record(Schema.String, Schema.String)),
	data: Schema.Unknown,
});
export type EventEnvelope = typeof EventEnvelope.Type;

export class UnknownEventTypeError extends Schema.TaggedError<UnknownEventTypeError>()("UnknownEventTypeError", {
	type: Schema.String,
}) {}

/** The transport's own readiness frame; it has no meaning inside the harness. */
export const Connected = EventSchema.define({ type: "server.connected", schema: {} });

/** Resolves a published type to the definition that encodes it. */
export type Registry = (type: string) => EventSchema.Definition | undefined;

/**
 * What a stock client can decode: the harness's public events plus the frames
 * the transport adds itself. A server may know more than this -- plugins
 * register their own types -- which is exactly why `data` crosses the wire
 * encoded and is decoded lazily, so an unknown type is skipped, not fatal.
 */
const core = EventSchema.latest([...EventList.PublicDefinitions, Connected]);
export const Core: Registry = (type) => core.get(type);

export class EncodingError extends Schema.TaggedError<EncodingError>()("EventEncodingError", {
	type: Schema.String,
	cause: Schema.Defect(),
}) {}

export const encode = Effect.fn("Envelope.encode")(function* (payload: EventSchema.Payload, registry: Registry = Core) {
	const definition = registry(payload.type);
	if (definition === undefined) return yield* new UnknownEventTypeError({ type: payload.type });
	const data = yield* Schema.encodeEffect(definition.data)(payload.data).pipe(
		Effect.mapError((cause) => new EncodingError({ type: payload.type, cause })),
	);
	return {
		id: payload.id,
		type: payload.type,
		...(payload.durable === undefined ? {} : { durable: payload.durable }),
		...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
		data,
	};
});

export const decode = Effect.fn("Envelope.decode")(function* (envelope: EventEnvelope, registry: Registry = Core) {
	const definition = registry(envelope.type);
	if (definition === undefined) {
		return yield* new UnknownEventTypeError({ type: envelope.type });
	}
	const data = yield* Schema.decodeEffect(definition.data)(envelope.data);
	return {
		id: envelope.id,
		type: envelope.type,
		...(envelope.durable === undefined ? {} : { durable: envelope.durable }),
		...(envelope.metadata === undefined ? {} : { metadata: envelope.metadata }),
		data,
	} as EventSchema.Payload;
});

export * as Envelope from "./envelope.ts";
