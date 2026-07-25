import { Effect, Fiber, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db";
import { SessionInputRow } from "../src/db/schema.sql";
import { RunnerExecute } from "../src/runner/execute";
import { RunnerExecution } from "../src/runner/execution";
import { Loop } from "../src/runner/loop";
import { tmpdir as osTmpdir } from "node:os";
import { SandboxInstance } from "../src/sandbox/instance";
import { Sandbox } from "../src/sandbox/sandbox";
import { Shell } from "../src/sandbox/shell";
import { SandboxStore } from "../src/sandbox/store";
import { AbsolutePath } from "../src/schema";
import { SessionSchema } from "../src/session/schema";
import { Session } from "../src/session/session";
import { testEffect } from "./utils/effect";

/**
 * The mock loop's work is a real shell command, so running this suite against
 * each backend is how the drain doubles as a SandboxIO exercise: same
 * assertions, different filesystem and shell underneath.
 *
 * Correctness runs use `intervalSeconds: 0` so a turn is only as slow as the
 * shell itself. The wall-clock behaviour the interval exists for is asserted
 * separately, in the soak suite at the bottom.
 */
const runtime = (sandbox: Layer.Layer<Sandbox.Provides>, options?: Loop.Options) =>
	RunnerExecute.layer.pipe(
		Layer.provide(Loop.layer(options)),
		// provideMerge, not provide: the specs below drive the sandbox directly to
		// assert what the loop's shell work actually does.
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Session.layer),
		Layer.provideMerge(SandboxStore.withFixtures(Database.layer(":memory:"))),
	);

const insertInput = (sql: SqlClient.SqlClient) =>
	SqlSchema.void({
		Request: SessionInputRow.insert,
		execute: (row) => sql`INSERT INTO session_input ${sql.insert(row)}`,
	});

const inputsFor = (sql: SqlClient.SqlClient) =>
	SqlSchema.findAll({
		Request: Schema.String,
		Result: SessionInputRow,
		execute: (sessionId) => sql`
			SELECT * FROM session_input WHERE session_id = ${sessionId} ORDER BY admitted_seq
		`,
	});

/** Promotion order per session, `null` where the input is still pending. */
const delivered = Effect.fnUntraced(function* (sessionId: string) {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* inputsFor(sql)(sessionId);
	return rows.map((row) => ({ id: row.id, promotedSeq: Option.getOrNull(row.promotedSeq) }));
});

const seedSession = Effect.fnUntraced(function* (directory = "/workspace") {
	const sql = yield* SqlClient.SqlClient;
	const sessions = yield* Session.Service;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('p', 'p', 0, 0)`;
	const session = yield* sessions.create({
		projectId: "p",
		slug: `run-${Date.now()}-${Math.random()}`,
		directory: AbsolutePath.make(directory),
		title: "runner loop",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
	return session.id;
});

// Stand-in for a real prompt: long enough to be truncated, with the whitespace
// and punctuation that would break a naively built shell command.
const lorem =
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit,\n sed do eiusmod tempor " +
	"incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud.";

const enqueue = Effect.fnUntraced(function* (input: {
	readonly id: string;
	readonly sessionId: SessionSchema.ID;
	readonly admittedSeq: number;
	readonly delivery: "steer" | "followUp";
	readonly text?: string;
}) {
	const sql = yield* SqlClient.SqlClient;
	const row = yield* SessionInputRow.insert.makeEffect({
		id: input.id,
		sessionId: input.sessionId,
		admittedSeq: input.admittedSeq,
		delivery: input.delivery,
		prompt: JSON.stringify({ parts: [{ type: "text", text: input.text ?? `${input.id} ${lorem}` }] }),
		promotedSeq: Option.none(),
	});
	yield* insertInput(sql)(row);
});

/** The drain spec every sandbox backend must satisfy. */
const loopSpec = (name: string, sandbox: () => Layer.Layer<Sandbox.Provides>) => {
	const options: Loop.Options = { intervalSeconds: 0, minLines: 2, maxLines: 7 };
	const { effect: it } = testEffect(runtime(sandbox(), options));

	describe(`runner loop — ${name}`, () => {
		it(
			"drains queued inputs in admission order and marks them delivered",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession();

				yield* enqueue({ id: "a", sessionId, admittedSeq: 1, delivery: "followUp" });
				yield* enqueue({ id: "b", sessionId, admittedSeq: 2, delivery: "steer" });

				yield* execution.resume(sessionId);

				expect(yield* delivered(sessionId)).toEqual([
					{ id: "a", promotedSeq: 1 },
					{ id: "b", promotedSeq: 2 },
				]);
			}),
		);

		it(
			"a second drain re-delivers nothing and renumbers nothing",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession();

				yield* enqueue({ id: "only", sessionId, admittedSeq: 1, delivery: "steer" });
				yield* execution.resume(sessionId);
				yield* execution.resume(sessionId);

				expect(yield* delivered(sessionId)).toEqual([{ id: "only", promotedSeq: 1 }]);
			}),
		);

		it(
			"promotion is scoped per session",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const first = yield* seedSession();
				const second = yield* seedSession();

				yield* enqueue({ id: "first-1", sessionId: first, admittedSeq: 1, delivery: "steer" });
				yield* enqueue({ id: "second-1", sessionId: second, admittedSeq: 1, delivery: "steer" });

				yield* execution.resume(first);
				yield* execution.resume(second);

				expect(yield* delivered(first)).toEqual([{ id: "first-1", promotedSeq: 1 }]);
				expect(yield* delivered(second)).toEqual([{ id: "second-1", promotedSeq: 1 }]);
			}),
		);

		it(
			"wake with nothing eligible idles; an explicit resume still takes a turn",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession();

				yield* execution.wake(sessionId); // force = false -> idle
				yield* execution.resume(sessionId); // force = true  -> one turn anyway

				expect(yield* delivered(sessionId)).toEqual([]);
				expect(Array.from(yield* execution.active)).toEqual([]);
			}),
		);

		it(
			"fails for a session that does not exist",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const exit = yield* execution.resume(SessionSchema.ID.create()).pipe(Effect.exit);
				expect(exit._tag).toBe("Failure");
			}),
		);

		it(
			"quotes prompt text so shell metacharacters stay literal",
			Effect.gen(function* () {
				const shell = yield* Shell;
				// Everything an unquoted command would act on rather than print.
				const hostile = `a ' b $(echo pwned) c \`id\` d ; e && f | g > h`;

				const result = yield* shell.exec(Loop.script(hostile, 1, 0));

				expect(result.exitCode).toBe(0);
				// Exact equality is the assertion: had the substitution run, the
				// output would read "... c d ..." with the command's result spliced in.
				expect(result.stdout.trim()).toBe(`${hostile} 1`);
			}),
		);

		it(
			"drains a batch of prompts, quoting and truncating each without breaking the shell",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession();

				// Prompts carrying the metacharacters an unquoted command would trip on.
				const hostile = [
					`plain ${lorem}`,
					`quotes ' " and $(echo pwned) backticks \`id\``,
					"semi; colon && ampersand | pipe > redirect",
					"unicode ✓ — em dash, and \\ backslash",
				];
				for (const [index, text] of hostile.entries()) {
					yield* enqueue({
						id: `input-${index}`,
						sessionId,
						admittedSeq: index + 1,
						delivery: index % 2 === 0 ? "steer" : "followUp",
						text,
					});
				}

				yield* execution.resume(sessionId);

				expect(yield* delivered(sessionId)).toEqual(
					hostile.map((_, index) => ({ id: `input-${index}`, promotedSeq: index + 1 })),
				);
			}),
		);
	});
};

loopSpec("memory (just-bash)", () => Sandbox.memory());
loopSpec("sqldb (just-bash over sqlite)", () => Sandbox.sqldb());
// The loop only reads `pwd` and echoes to stdout, so any existing directory
// serves as the host cwd and nothing needs cleaning up afterwards.
loopSpec("local host", () => Sandbox.local(osTmpdir()));

describe("runner loop — interruption", () => {
	// A turn slow enough to be caught mid-flight, on a real clock.
	const { live: itSlow } = testEffect(runtime(Sandbox.memory(), { intervalSeconds: 1, minLines: 30, maxLines: 30 }));

	itSlow(
		"an interrupted turn leaves its input eligible for the next drain",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession();
			yield* enqueue({ id: "pending", sessionId, admittedSeq: 1, delivery: "steer" });

			const fiber = yield* Effect.forkChild(execution.resume(sessionId));

			// Wait for the coordinator to own the drain before cutting it.
			yield* Effect.gen(function* () {
				while (!(yield* execution.active).has(sessionId)) {
					yield* Effect.sleep("10 millis");
				}
			}).pipe(Effect.timeout("5 seconds"), Effect.orDie);

			yield* execution.interrupt(sessionId);
			yield* Fiber.join(fiber).pipe(Effect.exit);

			// Promotion happens only after a turn completes, so an interrupt mid-turn
			// must leave the input unconsumed.
			expect(yield* delivered(sessionId)).toEqual([{ id: "pending", promotedSeq: null }]);
			expect(Array.from(yield* execution.active)).toEqual([]);
		}),
	);
});

/**
 * Soak: many prompts, each a real multi-second command, on a live clock. Opt in
 * with `CODEWORK_LOOP_SOAK=1` — at one second per line and 2–7 lines per input
 * this is minutes of wall clock by design, which is exactly what makes it a
 * useful shakedown of a backend and useless in the default suite.
 *
 * `CODEWORK_LOOP_SOAK_INPUTS` sets the prompt count (default 50).
 */
const soak = process.env.CODEWORK_LOOP_SOAK === "1" ? describe : describe.skip;

soak("runner loop — soak", () => {
	const options: Loop.Options = { intervalSeconds: 1, minLines: 2, maxLines: 7 };
	const count = Number(process.env.CODEWORK_LOOP_SOAK_INPUTS ?? 50);
	const { live: itSoak } = testEffect(runtime(Sandbox.memory(), options));

	itSoak(
		`drains ${count} prompts of 2–7 seconds each`,
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession();

			for (let index = 0; index < count; index++) {
				yield* enqueue({
					id: `soak-${index}`,
					sessionId,
					admittedSeq: index + 1,
					delivery: index % 3 === 0 ? "steer" : "followUp",
				});
			}

			const started = Date.now();
			yield* execution.resume(sessionId);
			const elapsed = Date.now() - started;

			const rows = yield* delivered(sessionId);
			expect(rows.map((row) => row.promotedSeq)).toEqual(Array.from({ length: count }, (_, i) => i + 1));

			// Every turn really waited: the floor is the sum of each input's lines.
			const expected = Array.from({ length: count }, (_, i) => Loop.linesFor(i + 1, options)).reduce(
				(total, lines) => total + lines,
				0,
			);
			expect(elapsed).toBeGreaterThanOrEqual(expected * 1000 * 0.8);
		}),
		{ timeout: 1000 * 60 * 20 },
	);
});
