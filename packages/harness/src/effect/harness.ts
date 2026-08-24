import { Effect, Layer } from "effect";
import { Context } from "../context/context.ts";
import { Control } from "../control.ts";
import { Database } from "../db/db.ts";
import { Event } from "../event/event.ts";
import { Global } from "../global.ts";
import { RunnerExecute } from "../runner/execute.ts";
import { LLM } from "../runner/llm.ts";
import { Loop } from "../runner/loop.ts";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxDriver } from "../sandbox/driver.ts";
import { SessionLive } from "../session/live.ts";
import { SessionRuntime } from "../session/runtime.ts";
import { State } from "../state/state.ts";
import type { Driver } from "./sandbox.ts";

export interface Options {
	readonly database?: string;
	readonly home?: string;
	readonly sandboxes?: ReadonlyArray<Driver>;
	readonly llm?: LLM.Open;
}

export const layer = (options: Options = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const paths = yield* Global.resolve(options.home === undefined ? {} : { home: options.home });
			const configuredDatabase = options.database ?? (yield* Database.locationConfig);
			const global = Global.layerWith(paths);
			const database = Database.layer(Database.resolveLocation(configuredDatabase, paths.data));
			const drivers = SandboxDriver.layer(...(options.sandboxes ?? []));
			const sandboxes = SandboxController.layer().pipe(Layer.provideMerge(drivers), Layer.provideMerge(database));
			const loop = options.llm === undefined ? Loop.layer() : Loop.layer({ request: LLM.make(options.llm) });

			return Control.layer.pipe(
				Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(loop))),
				Layer.provideMerge(State.layer()),
				Layer.provideMerge(SessionRuntime.layer),
				Layer.provideMerge(sandboxes),
				Layer.provideMerge(Context.layer),
				Layer.provideMerge(SessionLive.layer),
				Layer.provideMerge(Event.layer),
				Layer.provideMerge(database),
				Layer.provideMerge(global),
			);
		}),
	);

export * as Harness from "./harness.ts";
