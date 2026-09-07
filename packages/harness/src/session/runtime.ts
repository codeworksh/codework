import { Context, Effect, Layer, Option, Ref } from "effect";
import type { SessionSchema } from "./schema.ts";
import type { State } from "../state/state.ts";

/**
 * Per-session configuration, held in process.
 *
 * This is the only config layer between `State.defaults` and a caller's
 * `State.layer(options)` -- nothing here is written to the session log, so nothing
 * survives a restart. `Session.attach` merges into it rather than replacing it.
 */
export type Bindings = State.Options;

export interface Interface {
	readonly get: (sessionId: SessionSchema.ID) => Effect.Effect<Option.Option<Bindings>>;
	readonly set: (sessionId: SessionSchema.ID, bindings: Bindings) => Effect.Effect<void>;
	readonly update: (sessionId: SessionSchema.ID, patch: Bindings) => Effect.Effect<void>;
	readonly remove: (sessionId: SessionSchema.ID) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/session/runtime/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const bindings = yield* Ref.make(new Map<SessionSchema.ID, Bindings>());

		const get = (sessionId: SessionSchema.ID) =>
			Ref.get(bindings).pipe(Effect.map((entries) => Option.fromUndefinedOr(entries.get(sessionId))));

		const set = (sessionId: SessionSchema.ID, value: Bindings) =>
			Ref.update(bindings, (entries) => {
				const next = new Map(entries);
				next.set(sessionId, value);
				return next;
			});

		const update = (sessionId: SessionSchema.ID, patch: Bindings) =>
			Ref.update(bindings, (entries) => {
				const next = new Map(entries);
				next.set(sessionId, { ...entries.get(sessionId), ...patch });
				return next;
			});

		const remove = (sessionId: SessionSchema.ID) =>
			Ref.update(bindings, (entries) => {
				const next = new Map(entries);
				next.delete(sessionId);
				return next;
			});

		return Service.of({ get, set, update, remove });
	}),
);

export * as SessionRuntime from "./runtime.ts";
