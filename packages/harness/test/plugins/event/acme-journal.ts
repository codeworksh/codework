import { EventSchema } from "../../../src/event/schema.ts";
import { define } from "../../../src/plugin/plugin.ts";
// A plugin owning durable event types outside the kernel manifest.
import { Effect, Schema } from "effect";

export const Marker = EventSchema.define({
	type: "acme.journal.marker",
	durable: { aggregate: "sessionId", version: 1 } as const,
	schema: { sessionId: Schema.String, note: Schema.String },
});

export const Ready = EventSchema.define({
	type: "acme.ready",
	schema: { sessionId: Schema.String },
});

export default define({
	id: "acme.journal.writer",
	setup: (ctx) =>
		Effect.gen(function* () {
			yield* ctx.events.publish(Ready, { sessionId: ctx.sessionId });
			yield* ctx.events.publish(Marker, { sessionId: ctx.sessionId, note: "acme was here" });
		}),
});
