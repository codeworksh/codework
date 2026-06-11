import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

// Virtual sandboxes have no operating system behind them; attempting to run
// a child process is a wiring mistake, surfaced as a defect.
export const unsupported = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() => Effect.die(new Error("process execution is not supported by this sandbox"))),
);

export * as Process from "./process";
