import { Global } from "@codeworksh/harness/effect";
import { Effect, Layer, Schedule } from "effect";
import * as Relay from "./relay.ts";

/**
 * While the server runs, each connected workspace hears from this machine every 30 seconds; the relay
 * shows it online for 90. `machine.json` is read on every beat, so a `codework connect` made while the
 * server runs is picked up without a restart. Nothing here is fatal: local work never waits on the relay.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const global = yield* Global.Service;
		yield* Relay.heartbeat(global.home).pipe(
			Effect.catch((error) => Effect.logDebug("Machine heartbeat failed", error)),
			Effect.repeat(Schedule.spaced("30 seconds")),
			Effect.forkScoped,
		);
	}),
);
