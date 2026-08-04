import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../../src/sandbox/fs/filesystem";
import { Shell } from "../../src/sandbox/shell/shell";

/**
 * The contract: **when the parent fiber is interrupted, the command underneath
 * must terminate.** A fiber that unwinds promptly is not evidence of that — the
 * work can carry on writing to the namespace long after its caller is gone, and
 * on a shared sandbox that is another run's filesystem being mutated by work
 * somebody already cancelled.
 *
 * The assertion is therefore made against the sandbox filesystem, the one
 * witness every backend shares. A command appends a line per second; after the
 * interrupt the line count must stop moving.
 *
 * Where a backend *cannot* honour it — a provider whose exec API offers no
 * cancellation path — that is a limitation of the provider, and declaring
 * `cancels: false` turns it into a tested fact instead of folklore. Such a
 * backend is asserted to keep running, so on the day the provider gains
 * cancellation this suite fails and says so.
 */
export interface CancellationEnv {
	/**
	 * Runs a program against an assembled sandbox. Taken as a runner rather than
	 * a Layer so the remote suites can reuse the single sandbox they already
	 * provisioned instead of paying for another.
	 */
	readonly run: <A>(program: Effect.Effect<A, never, SandboxFileSystem.Service | Shell>) => Promise<A>;
	/** Writable absolute path in that namespace to use as the witness file. */
	readonly witness: string;
	/** Whether interrupting the fiber is expected to stop the command. */
	readonly cancels: boolean;
	/** Gap between the two post-interrupt samples. Longer for remote backends. */
	readonly settleMillis?: number;
	readonly dispose?: () => Promise<void>;
}

export const cancellationSpec = (name: string, make: () => CancellationEnv | Promise<CancellationEnv>) => {
	describe(`interruption — ${name}`, () => {
		it("the underlying command follows the fiber's interruption", async () => {
			const env = await make();
			const settle = env.settleMillis ?? 2000;
			try {
				const observed = await env.run(
					Effect.gen(function* () {
						const filesystem = yield* SandboxFileSystem.Service;
						const shell = yield* Shell;

						const ticks = filesystem.readFile(env.witness).pipe(
							Effect.map((content) => content.split("\n").filter((line) => line.length > 0).length),
							Effect.orElseSucceed(() => 0),
						);

						// Far longer than the test: it has to be mid-flight when cut.
						const fiber = yield* Effect.forkChild(
							shell.exec(`for i in $(seq 1 120); do echo tick >> ${env.witness}; sleep 1; done`),
						);

						// Interrupt real work, not a command that has not started.
						yield* Effect.gen(function* () {
							while ((yield* ticks) < 1) {
								yield* Effect.sleep("50 millis");
							}
						}).pipe(Effect.timeout("60 seconds"), Effect.orDie);

						yield* Fiber.interrupt(fiber);

						// Two samples: what matters is whether the count is still
						// moving, not its exact value — a backend may finish the
						// iteration already in flight before it notices the abort.
						yield* Effect.sleep(settle);
						const settled = yield* ticks;
						yield* Effect.sleep(settle);
						const later = yield* ticks;

						return { settled, later };
					}).pipe(Effect.scoped),
				);

				// The command really was running when we cut it.
				expect(observed.settled).toBeGreaterThan(0);

				if (env.cancels) {
					expect(observed.later).toBe(observed.settled);
				} else {
					// Recorded as a provider limitation. If this fails, the provider
					// learned to cancel — flip `cancels` to true.
					expect(observed.later).toBeGreaterThan(observed.settled);
				}
			} finally {
				await env.dispose?.();
			}
		}, 180_000);
	});
};
