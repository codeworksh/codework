import { Control, Harness, Sandbox } from "@codeworksh/harness/effect";
import { Effect, Logger, Stdio } from "effect";
import { Agent } from "./agent.ts";
import { Handlers } from "./handlers.ts";

// Sessions and managed sandboxes outlive any single request; the connection's end is what stops them.
const shutdown = Effect.gen(function* () {
	const control = yield* Control.Service;
	yield* Effect.forEach(
		yield* control.active,
		(id) =>
			control
				.interrupt(id, { reason: "shutdown", awaitSettlement: true })
				.pipe(Effect.timeout("10 seconds"), Effect.ignore),
		{ concurrency: "unbounded", discard: true },
	);
	const managed = (yield* Sandbox.list()).filter((info) => info.ownership === "managed");
	yield* Effect.forEach(
		managed,
		(info) =>
			Sandbox.stop(info.id).pipe(
				Effect.timeout("10 seconds"),
				Effect.catchCause((cause) =>
					Effect.logError("Failed to stop managed sandbox during ACP shutdown", cause).pipe(
						Effect.annotateLogs({ sandboxInstanceId: info.id }),
					),
				),
			),
		{ concurrency: "unbounded", discard: true },
	);
});

/**
 * Serves ACP v1 on stdio until the client disconnects.
 *
 * stdout carries the protocol, so logs go to stderr. The reference is set outside the harness layer
 * so the fibers it forks (turns, plugin loads) inherit it too.
 */
export const serve = (options: Harness.Options) =>
	Effect.gen(function* () {
		yield* Effect.addFinalizer(() => shutdown.pipe(Effect.ignore));
		const handlers = yield* Handlers.make;
		yield* Agent.serve(yield* Stdio.Stdio, handlers);
	}).pipe(Effect.scoped, Effect.provide(Harness.layer(options)), Effect.provideService(Logger.LogToStderr, true));

export * as Server from "./server.ts";
