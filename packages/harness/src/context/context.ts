import { Context, Effect, Layer, Option } from "effect";
import type { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";
import { assembleLine, type Snapshot } from "./assemble.ts";
import type { ContextDecodeError } from "./errors.ts";

export type ContextReadError = Thread.ThreadNotFoundError | ContextDecodeError;

export interface Interface {
	readonly assemble: (threadId: ThreadSchema.ID) => Effect.Effect<Snapshot, ContextReadError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/context/context/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const threads = yield* Thread.Service;
		const assemble = Effect.fn("Context.assemble")(function* (threadId: ThreadSchema.ID) {
			const found = yield* threads.get(threadId);
			if (Option.isNone(found)) return yield* new Thread.ThreadNotFoundError({ threadId });
			return yield* assembleLine(threadId, yield* threads.line(threadId));
		});
		return Service.of({ assemble });
	}),
);

export * from "./assemble.ts";
export * from "./codec.ts";
export * from "./errors.ts";

export * as Context from "./context.ts";
