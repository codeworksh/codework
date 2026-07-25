import { Effect, type Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import type { Shell } from "../src/sandbox/shell";
import { cancellationSpec } from "./fixtures/cancellation.spec";

/**
 * One contract, every local backend: interrupting the fiber must terminate the
 * command underneath it (see `fixtures/cancellation.spec.ts`).
 *
 * The remote backends run the same spec from their own credential-gated suites,
 * where a provider without a cancellation path declares `cancels: false` and its
 * limitation becomes a tested fact rather than an assumption.
 */

const runner =
	(sandbox: Layer.Layer<SandboxFileSystem.Service | Shell>) =>
	<A>(program: Effect.Effect<A, never, SandboxFileSystem.Service | Shell>) =>
		Effect.runPromise(program.pipe(Effect.provide(sandbox)));

// In-process bash over an in-memory VFS. Cancellation is cooperative: the
// interpreter stops at its next statement boundary once the signal aborts.
cancellationSpec("memory (just-bash)", () => ({
	run: runner(Sandbox.memory()),
	witness: "/progress",
	cancels: true,
}));

// The same interpreter over a sqlite-backed VFS — the shell is identical, so
// this asserts the storage swap does not change interruption behaviour.
cancellationSpec("sqldb (just-bash over sqlite)", () => ({
	run: runner(Sandbox.sqldb()),
	witness: "/progress",
	cancels: true,
}));

// Real OS processes. Here cancellation is the spawner's scope finalizer killing
// the process group, not a cooperative signal.
cancellationSpec("local host", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codework-cancel-"));
	return {
		run: runner(Sandbox.local(directory)),
		witness: join(directory, "progress"),
		cancels: true,
		dispose: () => rm(directory, { recursive: true, force: true }),
	};
});
