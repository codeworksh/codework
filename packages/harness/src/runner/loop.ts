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

import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { SessionInputRow } from "../db/schema.sql";
import { SandboxIO } from "../sandbox/io";
import { quote } from "../sandbox/shell/shell";
import type { SessionSchema } from "../session/schema";
import { Session } from "../session/session";
import { Runner } from "./run";

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
const echoText = (prompt: string): string => {
	const parts = ((): string => {
		try {
			const decoded: unknown = JSON.parse(prompt);
			const list =
				typeof decoded === "object" && decoded !== null && "parts" in decoded
					? (decoded as { parts?: ReadonlyArray<{ type?: string; text?: string }> }).parts
					: undefined;
			const text = (list ?? [])
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text as string)
				.join(" ");
			return text.length > 0 ? text : prompt;
		} catch {
			return prompt;
		}
	})();
	const flat = parts.replace(/\s+/g, " ").trim();
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
			const sql = yield* SqlClient.SqlClient;
			const sessions = yield* Session.Service;
			const intervalSeconds = options.intervalSeconds ?? defaults.intervalSeconds;

			// Eligible work: admitted, not yet delivered, oldest first. Covered by
			// session_input_pending_idx.
			const pending = SqlSchema.findAll({
				Request: Schema.String,
				Result: SessionInputRow,
				execute: (sessionId) => sql`
					SELECT * FROM session_input
					WHERE session_id = ${sessionId} AND promoted_seq IS NULL
					ORDER BY admitted_seq
				`,
			});

			// Delivery order is its own sequence, computed inside the statement so no
			// read-modify-write window opens between picking a value and using it.
			// The unique (session_id, promoted_seq) index is the backstop.
			const promote = SqlSchema.void({
				Request: Schema.Struct({ id: Schema.String, sessionId: Schema.String }),
				execute: (r) => sql`
					UPDATE session_input
					SET promoted_seq = (
						SELECT COALESCE(MAX(promoted_seq), 0) + 1 FROM session_input WHERE session_id = ${r.sessionId}
					)
					WHERE id = ${r.id}
				`,
			});

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

				const queued = yield* pending(input.sessionId).pipe(Effect.orDie);

				if (queued.length === 0) {
					// The contract in `run.ts`: an explicit run performs one attempt even
					// with nothing eligible; a wake with nothing eligible is a no-op.
					if (!input.force) {
						yield* Effect.logInfo("loop: nothing eligible, idling").pipe(
							Effect.annotateLogs({ sessionId: input.sessionId }),
						);
						return;
					}
					yield* turn("forced", "forced turn, no queued input", linesFor(0, options));
					return;
				}

				let emitted = 0;
				for (const queuedInput of queued) {
					const lines = linesFor(queuedInput.admittedSeq, options);
					yield* Effect.logInfo("loop: delivering input").pipe(
						Effect.annotateLogs({
							inputId: queuedInput.id,
							delivery: queuedInput.delivery,
							admittedSeq: queuedInput.admittedSeq,
						}),
					);
					const done = yield* turn(queuedInput.delivery, echoText(queuedInput.prompt), lines);
					emitted += done.emitted;
					// Consumed only after its turn completes, so an interrupt mid-turn
					// leaves the input eligible for the next drain.
					yield* promote({ id: queuedInput.id, sessionId: input.sessionId }).pipe(Effect.orDie);
				}

				yield* Effect.logInfo("loop: run end").pipe(
					Effect.annotateLogs({ sessionId: input.sessionId, delivered: queued.length, emitted }),
				);
			});

			return Runner.Service.of({ run });
		}),
	);

export * as Loop from "./loop";
