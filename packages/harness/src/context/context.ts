import { Context, Effect, Layer, Option } from "effect";
import { SessionSchema } from "../session/schema.ts";
import { Session } from "../session/session.ts";
import { assemblePath, type Snapshot } from "./assemble.ts";
import type { ContextDecodeError } from "./errors.ts";

export type ContextReadError = Session.SessionNotFoundError | ContextDecodeError;

export interface Interface {
	readonly assemble: (sessionId: SessionSchema.ID) => Effect.Effect<Snapshot, ContextReadError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/context/context/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sessions = yield* Session.Service;
		const assemble = Effect.fn("Context.assemble")(function* (sessionId: SessionSchema.ID) {
			const found = yield* sessions.get(sessionId);
			if (Option.isNone(found)) return yield* new Session.SessionNotFoundError({ sessionId });
			return yield* assemblePath(sessionId, yield* sessions.path(sessionId));
		});
		return Service.of({ assemble });
	}),
);

export * from "./assemble.ts";
export * from "./codec.ts";
export * from "./errors.ts";

export * as Context from "./context.ts";
