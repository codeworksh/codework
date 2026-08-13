/*
 * @file A stand-in `Runner.Service`: drains `session_input`, performs mock work,
 * and logs what it did.
 *
 * This exists so the parts *around* the loop — the coordinator's fiber
 * ownership, wake coalescing, and interruption, plus the sandbox services a run
 * executes against — can be exercised end to end before the real Effect-native
 * loop lands. It makes no LLM call and persists no session entries.
 *
 * It is deliberately shaped like the real thing: one durable read of eligible
 * work, one unit of latency per turn, terminal-only writes. Replacing it should
 * mean deleting this file and providing the real layer in its place, not
 * unpicking assumptions from the rest of `runner/`.
 */

import { Effect, Layer, Option } from "effect";
import { Event } from "../event/event.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { quote } from "../sandbox/shell/shell.ts";
import { SessionInput } from "../session/input/input.ts";
import type { SessionSchema } from "../session/schema.ts";
import { Session } from "../session/session.ts";
import { Runner } from "./run.ts";

export interface Options {
	/**
	 * Seconds between echoed lines. The default of one second makes a turn take
	 * {@link Options.minLines}–{@link Options.maxLines} seconds of real wall
	 * clock, which is the point: the work has to last long enough to interrupt,
	 * to overlap with another session's drain, and to be worth cancelling on a
	 * remote backend. Tests that only care about correctness pass `0`.
	 */
	readonly intervalSeconds?: number;
	/** Fewest lines a turn echoes. */
	readonly minLines?: number;
	/** Most lines a turn echoes. */
	readonly maxLines?: number;
}

const defaults = { intervalSeconds: 1, minLines: 2, maxLines: 7 } as const;

/**
 * Lines this input's turn will echo — and therefore, at one second apart, how
 * many seconds it runs. Derived from admission order rather than randomly so a
 * matrix run is reproducible and a test can predict the total.
 */
export const linesFor = (admittedSeq: number, options: Options = {}): number => {
	const min = options.minLines ?? defaults.minLines;
	const max = options.maxLines ?? defaults.maxLines;
	const span = Math.max(1, max - min + 1);
	return min + (Math.abs(admittedSeq) % span);
};

/**
 * Collapse a queued prompt to one echoable line: whitespace normalized so the
 * emitted line count is exactly the loop count, and truncated so a long lorem
 * ipsum body does not dominate the command.
 */
const promptText = (hydrated: Session.HydratedEntry): string => {
	for (const part of hydrated.parts) {
		if (part.type !== "text") continue;
		const parsed: unknown = JSON.parse(part.data);
		if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
			return String((parsed as { text: unknown }).text);
		}
	}
	return hydrated.entry.id;
};

const echoText = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= 60 ? flat : `${flat.slice(0, 57)}...`;
};

/**
 * A portable long-running command: echo a line, wait, repeat. Every backend in
 * the matrix supports `seq`, `sleep`, and `for` — just-bash included — so one
 * script exercises the in-memory VFS, the host, and a remote microVM
 * identically.
 *
 * The text is single-quoted through {@link quote} because a queued prompt is
 * arbitrary user input; `$i` stays outside the quotes so the shell expands it.
 */
export const script = (text: string, lines: number, intervalSeconds: number): string =>
	`for i in $(seq 1 ${lines}); do echo ${quote(text)} "$i"; sleep ${intervalSeconds}; done`;

export const layer = (options: Options = {}) =>
	Layer.effect(
		Runner.Service,
		Effect.gen(function* () {
			const sessions = yield* Session.Service;
			const events = yield* Event.Service;
			const inputs = yield* SessionInput.make;
			const intervalSeconds = options.intervalSeconds ?? defaults.intervalSeconds;

			/**
			 * The mock's one real use of the sandbox: ask the shell where it is, and
			 * confirm the filesystem agrees that place exists. Both calls go through
			 * whichever namespace was mounted for this run, which is the property
			 * worth proving before the real loop depends on it.
			 */
			const probe = Effect.fnUntraced(function* () {
				const shell = yield* SandboxIO.Shell;
				const fs = yield* SandboxIO.FileSystem;
				const pwd = yield* shell.exec("pwd").pipe(
					Effect.map((result) => result.stdout.trim()),
					Effect.orElseSucceed(() => "<shell unavailable>"),
				);
				const reachable = yield* fs.exists(pwd).pipe(Effect.orElseSucceed(() => false));
				return { pwd, reachable };
			});

			/**
			 * One unit of mock work: a real command, in the mounted namespace,
			 * running long enough to be worth interrupting. This is the whole reason
			 * the mock exists — a `sleep` in this process would prove nothing about
			 * the sandbox, whereas a shell loop exercises exec, quoting, output
			 * capture, cwd, and (where a backend supports it) cancellation.
			 */
			const turn = Effect.fnUntraced(function* (label: string, text: string, lines: number) {
				const shell = yield* SandboxIO.Shell;
				yield* Effect.logInfo("loop: turn start").pipe(Effect.annotateLogs({ label, lines, intervalSeconds }));
				const result = yield* shell
					.exec(script(text, lines, intervalSeconds))
					.pipe(Effect.mapError((cause) => new Runner.ShellWorkError({ command: cause.command, cause })));
				const emitted = result.stdout.split("\n").filter((line) => line.length > 0).length;
				yield* Effect.logInfo("loop: turn end").pipe(
					Effect.annotateLogs({ label, exitCode: result.exitCode, emitted }),
				);
				return { exitCode: result.exitCode, emitted };
			});

			const run = Effect.fn("Loop.run")(function* (input: {
				readonly sessionId: SessionSchema.ID;
				readonly force: boolean;
			}) {
				const session = yield* sessions.get(input.sessionId);
				if (Option.isNone(session)) {
					return yield* Effect.die(`session not found: ${input.sessionId}`);
				}

				const where = yield* probe();
				yield* Effect.logInfo("loop: run start").pipe(
					Effect.annotateLogs({
						sessionId: input.sessionId,
						directory: session.value.directory,
						pwd: where.pwd,
						pwdExists: where.reachable,
						force: input.force,
					}),
				);

				const hasSteer = yield* inputs.hasPending(input.sessionId, "steer");
				const hasFollowUp = hasSteer ? false : yield* inputs.hasPending(input.sessionId, "followUp");

				if (!input.force && !hasSteer && !hasFollowUp) {
					// The contract in `run.ts`: an explicit run performs one attempt even
					// with nothing eligible; a wake with nothing eligible is a no-op.
					yield* Effect.logInfo("loop: nothing eligible, idling").pipe(
						Effect.annotateLogs({ sessionId: input.sessionId }),
					);
					return;
				}

				let emitted = 0;
				let delivered = 0;
				let lane: "steer" | "followUp" | undefined = hasSteer ? "steer" : hasFollowUp ? "followUp" : undefined;
				let shouldRun = true;

				while (shouldRun) {
					// Captured before promoting and outside any commit, so a prompt admitted
					// from here on belongs to the next turn rather than this one. The real
					// loop keeps this ordering for the same reason.
					const cutoff = yield* events.latestSequence(input.sessionId);
					let promoted = 0;
					if (lane === "followUp") {
						promoted += Number(yield* inputs.promoteFollowUp(input.sessionId));
					}
					promoted += yield* inputs.promoteSteers(input.sessionId, cutoff);
					delivered += promoted;

					// Promotion appended the prompt, so the newest entry is the text this
					// turn is answering. Reading it back is also how the mock proves the
					// admit -> promote -> entry chain actually closed.
					const path = yield* sessions.path(input.sessionId);
					const newest = path.at(-1);
					const text = newest === undefined ? "forced turn, no queued input" : promptText(newest);
					const lines = linesFor(newest?.entry.seq ?? 0, options);

					yield* Effect.logInfo("loop: delivering").pipe(
						Effect.annotateLogs({ sessionId: input.sessionId, lane: lane ?? "forced", promoted }),
					);
					const done = yield* turn(lane ?? "forced", echoText(text), lines);
					emitted += done.emitted;

					// Every further pass must promote something, which is what bounds
					// this loop: inputs are finite, and a pass that delivers nothing has
					// nothing left it is allowed to deliver. Without it, a promotion
					// that silently fails to stamp promoted_seq — a projector missing
					// from the graph, say — spins here forever.
					if (promoted === 0) break;

					// One follow-up per run, and only once the steer lane is quiet — the
					// same precedence the real drain uses.
					if (yield* inputs.hasPending(input.sessionId, "steer")) {
						lane = "steer";
						continue;
					}
					shouldRun = yield* inputs.hasPending(input.sessionId, "followUp");
					lane = shouldRun ? "followUp" : undefined;
				}

				yield* Effect.logInfo("loop: run end").pipe(
					Effect.annotateLogs({ sessionId: input.sessionId, delivered, emitted }),
				);
			});

			return Runner.Service.of({ run });
		}),
	);

export * as Loop from "./loop.ts";
