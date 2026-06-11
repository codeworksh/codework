import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

// Child processes spawn directly on the host operating system. Note that
// host processes see the real filesystem, not the sandbox's virtual one.
export const host = NodeChildProcessSpawner.layer.pipe(Layer.provide([NodeFileSystem.layer, NodePath.layer]));

// Virtual sandboxes have no operating system behind them; attempting to run
// a child process is a wiring mistake, surfaced as a defect.
export const unsupported = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() => Effect.die(new Error("process execution is not supported by this sandbox"))),
);

export * as Process from "./process";
