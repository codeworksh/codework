// A plugin owning durable event types outside the kernel manifest. `publish` only
// reads { type, durable, data } off the definition, so a plain object suffices.
import { Effect, Schema } from "effect";

export const Marker = {
	type: "acme.journal.marker",
	durable: { aggregate: "sessionId", version: 1 },
	data: Schema.Struct({ sessionId: Schema.String, note: Schema.String }),
};

export const Ready = {
	type: "acme.ready",
	data: Schema.Struct({ sessionId: Schema.String }),
};

export default {
	id: "acme.journal.writer",
	setup: (ctx) =>
		Effect.gen(function* () {
			yield* ctx.events.publish(Ready, { sessionId: ctx.sessionId });
			yield* ctx.events.publish(Marker, { sessionId: ctx.sessionId, note: "acme was here" });
		}),
};
