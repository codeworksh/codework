import { Schema } from "effect";

/*
 * The event log's wire contract: what views, backends and the app server exchange. Topics are
 * namespaced by package, "<package>/<name>"; a widget publishes only under its own package.
 */

/**
 * One published event. `seq` orders stored events across all topics; an ephemeral event is never
 * stored, so it has none and reaches only subscribers live at the time.
 */
export const Event = Schema.Struct({
	/** Chosen by the publisher; publishing the same id again returns the stored event. */
	id: Schema.String,
	seq: Schema.optionalKey(Schema.Int),
	topic: Schema.String,
	/** Who published it, e.g. a widget instance id. */
	source: Schema.String,
	/** The id of the event this one answers, for request and reply. */
	cause: Schema.optionalKey(Schema.String),
	payload: Schema.Json,
	/** Epoch milliseconds. */
	created: Schema.Number,
});
export type Event = typeof Event.Type;

const outgoing = {
	/** Defaults to a fresh id. */
	id: Schema.optionalKey(Schema.String),
	topic: Schema.String,
	source: Schema.String,
	cause: Schema.optionalKey(Schema.String),
	payload: Schema.Json,
};

export const Publish = Schema.Struct({
	...outgoing,
	/** Deliver live only, without storing it. */
	ephemeral: Schema.optionalKey(Schema.Boolean),
});
export type Publish = typeof Publish.Type;

/** A request is always stored: its reply is matched to it, and a retry finds the stored reply. */
export const Request = Schema.Struct(outgoing);
export type Request = typeof Request.Type;

/** No reply to a request arrived in time. */
export class EventTimeout extends Schema.TaggedError<EventTimeout>()("Widget.EventTimeout", {
	id: Schema.String,
	topic: Schema.String,
}) {}

/** Ends a subscription's replay: everything through `seq` was sent, live events follow. */
export const Synced = Schema.TaggedStruct("Synced", { seq: Schema.Int });
export type Synced = typeof Synced.Type;

export * as WidgetEvent from "./event.ts";
