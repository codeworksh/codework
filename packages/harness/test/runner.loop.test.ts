import { Message } from "@codeworksh/aikit";
import { Effect, Layer, Option, Schema } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { tmpdir as osTmpdir } from "node:os";
import { describe, expect } from "vite-plus/test";
import { Control } from "../src/control.ts";
import { HarnessContext } from "../src/context/context.ts";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { SessionInputRow } from "../src/db/schema.sql.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { MemorySandboxDriver } from "../src/sandbox/drivers/memory.ts";
import { SqldbSandboxDriver } from "../src/sandbox/drivers/sqldb.ts";
import type { SandboxCreateError } from "../src/sandbox/errors.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { Shell } from "../src/sandbox/shell/shell.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

/**
 * The loop retains a real shell command alongside the aikit call, so running
 * this suite against each backend keeps the drain a SandboxIO exercise: same
 * assertions, different filesystem and shell underneath.
 *
 * Correctness runs use `intervalSeconds: 0` so a turn is only as slow as the
 * shell itself. The wall-clock behaviour the interval exists for is asserted
 * separately, in the soak suite at the bottom.
 */
interface LoopBackend {
	readonly drivers: ReadonlyArray<SandboxDriver.Registration>;
	readonly target: Effect.Effect<
		{
			readonly instanceId: SandboxInstance.ID;
			readonly directory: AbsolutePath;
		},
		SandboxCreateError,
		SandboxController.Controller
	>;
}

const managedBackend = <CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase>(
	driver: SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration,
	config: CreateConfig,
	directory: AbsolutePath,
): LoopBackend => ({
	drivers: [driver],
	target: Effect.gen(function* () {
		const controller = yield* SandboxController.Controller;
		const instance = yield* controller.create({ driver, config });
		return { instanceId: instance.id, directory };
	}),
});

const memoryBackend = (): LoopBackend => {
	const memory = MemorySandboxDriver.make();
	const directory = SandboxDriver.AbsolutePath.make("/workspace");
	return managedBackend(
		memory.driver,
		{
			defaultCwd: directory,
			initializeCwd: directory,
		},
		AbsolutePath.make(directory),
	);
};

const sqldbBackend = (): LoopBackend => {
	const sqldb = SqldbSandboxDriver.make();
	const directory = SandboxDriver.AbsolutePath.make("/workspace");
	return managedBackend(
		sqldb.driver,
		{
			defaultCwd: directory,
			initializeCwd: directory,
		},
		AbsolutePath.make(directory),
	);
};

const localBackend = (): LoopBackend => ({
	drivers: [],
	target: Effect.succeed({
		instanceId: SandboxInstance.ID.local,
		directory: AbsolutePath.make(osTmpdir()),
	}),
});

const runtime = (backend: LoopBackend, options?: Loop.Options) => {
	const database = Database.layer(":memory:");
	let responseIndex = 0;
	const complete: Loop.Completion = Effect.fnUntraced(function* (input) {
		responseIndex += 1;
		return Message.createAssistantMessage({
			messageId: `assistant_${responseIndex}_${crypto.randomUUID()}`,
			role: "assistant",
			protocol: "openai",
			provider: { id: input.provider, name: input.provider, source: "custom", env: [] },
			model: input.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			time: { created: responseIndex, completed: responseIndex },
			parts: [{ type: "text", text: `response ${responseIndex}` }],
		});
	});
	const infrastructure = Layer.provideMerge(
		SandboxController.layer().pipe(Layer.provide(SandboxDriver.layer(...backend.drivers))),
		database,
	);
	return Control.layer.pipe(
		Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(Loop.layer({ ...options, complete })))),
		Layer.provideMerge(HarnessContext.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.layer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(infrastructure),
	);
};

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

const seedSession = Effect.fnUntraced(function* (backend: LoopBackend) {
	const sql = yield* SqlClient.SqlClient;
	const sessions = yield* Session.Service;
	const target = yield* backend.target;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('p', 'p', 0, 0)`;
	const session = yield* sessions.create({
		projectId: "p",
		slug: `run-${Date.now()}-${Math.random()}`,
		directory: target.directory,
		title: "runner loop",
		sandboxInstanceId: target.instanceId,
	});
	return session.id;
});

// Stand-in for a real prompt: long enough to be truncated, with the whitespace
// and punctuation that would break a naively built shell command.
const lorem =
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit,\n sed do eiusmod tempor " +
	"incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud.";

// Admitted through the real entry point, never by raw insert: admitted_seq is a
// position in the session's durable log, so a fabricated one is meaningless and
// the drain's cutoff correctly ignores it.
const enqueue = Effect.fnUntraced(function* (input: {
	readonly id: string;
	readonly sessionId: SessionSchema.ID;
	readonly delivery: "steer" | "followUp";
	readonly text?: string;
}) {
	const control = yield* Control.Service;
	return yield* control.prompt({
		sessionId: input.sessionId,
		id: SessionMessageSchema.ID.make(input.id),
		prompt: { text: input.text ?? `${input.id} ${lorem}` },
		delivery: input.delivery,
	});
});

/** Admit durable inbox work without a process wake, for deterministic batch policy tests. */
const admit = Effect.fnUntraced(function* (input: {
	readonly id: string;
	readonly sessionId: SessionSchema.ID;
	readonly delivery: "steer" | "followUp";
	readonly text?: string;
}) {
	const inputs = yield* SessionInput.make;
	return yield* inputs.admit({
		id: SessionMessageSchema.ID.make(input.id),
		sessionId: input.sessionId,
		prompt: { text: input.text ?? `${input.id} ${lorem}` },
		delivery: input.delivery,
	});
});

/** The drain spec every sandbox backend must satisfy. */
const loopSpec = (name: string, backend: LoopBackend) => {
	const options: Loop.Options = { intervalSeconds: 0, minLines: 2, maxLines: 7 };
	const { effect: it } = testEffect(runtime(backend, options));

	describe(`runner loop — ${name}`, () => {
		it(
			"drains the steer lane before the follow-up lane, marking each delivered",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession(backend);

				yield* admit({ id: "msg_a", sessionId, delivery: "followUp" });
				yield* admit({ id: "msg_b", sessionId, delivery: "steer" });

				yield* execution.resume(sessionId);

				// Steers outrank follow-ups, so the later-admitted steer is delivered
				// first. Positions come from the log rather than a queue counter, so
				// what matters is the relative order, not the values.
				const rows = yield* delivered(sessionId);
				const bySeq = [...rows].sort((x, y) => (x.promotedSeq ?? 0) - (y.promotedSeq ?? 0));
				expect(bySeq.map((row) => row.id)).toEqual(["msg_b", "msg_a"]);
				expect(rows.every((row) => row.promotedSeq !== null)).toBe(true);
				// Only the promoted user entries exist: this slice has no assistant
				// write path. The assistant interleaving is asserted by the LLM
				// projector tests once `session.llm.ended` lands.
				const sessions = yield* Session.Service;
				expect((yield* sessions.path(sessionId)).map((item) => item.entry.type)).toEqual(["user", "user"]);
			}),
		);

		it(
			"a second drain re-delivers nothing and renumbers nothing",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession(backend);

				yield* enqueue({ id: "msg_only", sessionId, delivery: "steer" });
				yield* execution.resume(sessionId);
				yield* execution.resume(sessionId);

				expect(yield* delivered(sessionId)).toEqual([{ id: "msg_only", promotedSeq: 1 }]);
			}),
		);

		it(
			"promotion is scoped per session",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const first = yield* seedSession(backend);
				const second = yield* seedSession(backend);

				yield* enqueue({ id: "msg_first-1", sessionId: first, delivery: "steer" });
				yield* enqueue({ id: "msg_second-1", sessionId: second, delivery: "steer" });

				yield* execution.resume(first);
				yield* execution.resume(second);

				expect(yield* delivered(first)).toEqual([{ id: "msg_first-1", promotedSeq: 1 }]);
				expect(yield* delivered(second)).toEqual([{ id: "msg_second-1", promotedSeq: 1 }]);
			}),
		);

		/**
		 * The delivery order the whole design turns on, and the one thing that must
		 * not drift when the real loop replaces this mock: steers drain as a batch
		 * while the lane keeps producing, and only once it is quiet does a single
		 * follow-up go, one per pass. Interleaved admission does not reorder them.
		 */
		it(
			"delivers all pending steers before follow-ups, one follow-up per pass",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessions = yield* Session.Service;
				const sessionId = yield* seedSession(backend);

				// Admitted interleaved, so lane precedence — not arrival — decides.
				yield* admit({ id: "msg_s1", sessionId, delivery: "steer" });
				yield* admit({ id: "msg_f1", sessionId, delivery: "followUp" });
				yield* admit({ id: "msg_s2", sessionId, delivery: "steer" });
				yield* admit({ id: "msg_f2", sessionId, delivery: "followUp" });
				yield* admit({ id: "msg_s3", sessionId, delivery: "steer" });

				yield* execution.resume(sessionId);

				// Steers in admission order, then follow-ups in admission order.
				const path = (yield* sessions.path(sessionId)).filter((item) => item.entry.type === "user");
				expect(path.map((h) => h.entry.id)).toEqual(["msg_s1", "msg_s2", "msg_s3", "msg_f1", "msg_f2"]);

				// Conversation order is delivery order: the entry positions ascend in
				// exactly the sequence the inbox recorded them as promoted.
				const rows = yield* delivered(sessionId);
				const byPromotion = [...rows]
					.filter((row) => row.promotedSeq !== null)
					.sort((a, b) => a.promotedSeq! - b.promotedSeq!);
				expect(byPromotion.map((row) => row.id)).toEqual(path.map((h) => h.entry.id));
			}),
		);

		it(
			"wake with nothing eligible idles; an explicit resume still takes a turn",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const sessionId = yield* seedSession(backend);

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
				// Everything an unquoted command would act on rather than print.
				const hostile = `a ' b $(echo pwned) c \`id\` d ; e && f | g > h`;
				const target = yield* backend.target;
				const controller = yield* SandboxController.Controller;

				const result = yield* Effect.flatMap(Shell, (shell) => shell.exec(Loop.script(hostile, 1, 0))).pipe(
					Effect.provide(controller.mount(target.instanceId, { cwd: target.directory })),
					Effect.scoped,
				);

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
				const sessionId = yield* seedSession(backend);

				// Prompts carrying the metacharacters an unquoted command would trip on.
				const hostile = [
					`plain ${lorem}`,
					`quotes ' " and $(echo pwned) backticks \`id\``,
					"semi; colon && ampersand | pipe > redirect",
					"unicode ✓ — em dash, and \\ backslash",
				];
				for (const [index, text] of hostile.entries()) {
					yield* enqueue({
						id: `msg_input-${index}`,
						sessionId,
						delivery: index % 2 === 0 ? "steer" : "followUp",
						text,
					});
				}

				yield* execution.resume(sessionId);

				// Every prompt lands, whichever lane it arrived on.
				const rows = yield* delivered(sessionId);
				expect(rows.map((row) => row.id).sort()).toEqual(hostile.map((_, index) => `msg_input-${index}`).sort());
				expect(rows.every((row) => row.promotedSeq !== null)).toBe(true);
			}),
		);
	});
};

loopSpec("memory (just-bash)", memoryBackend());
loopSpec("sqldb (just-bash over sqlite)", sqldbBackend());
loopSpec("local host", localBackend());

describe("runner loop — interruption", () => {
	const backend = memoryBackend();
	// A turn slow enough to be caught mid-flight, on a real clock.
	const { live: itSlow } = testEffect(runtime(backend, { intervalSeconds: 1, minLines: 30, maxLines: 30 }));

	/**
	 * Blocks until the turn is genuinely in flight: its input durably promoted and
	 * its sandbox command started. `active` is no signal — it holds the key from
	 * the instant the wake registers it, before the drain fiber has run a step.
	 */
	const turnInFlight = (sessionId: SessionSchema.ID) =>
		Effect.gen(function* () {
			while (
				(yield* delivered(sessionId)).every((row) => row.promotedSeq === null) ||
				!(yield* TestConsole.logLines).includes("loop: sandbox turn start")
			) {
				yield* Effect.sleep("10 millis");
			}
		}).pipe(Effect.timeout("10 seconds"), Effect.orDie);

	itSlow(
		"an interrupted turn leaves its prompt promoted and the session idle",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession(backend);
			// Admitting is what starts the drain, so this is the production path
			// exactly. An explicit `resume` on top would race it: the wake already
			// owns the key, and if the interrupt lands before the resume fiber runs
			// its first step it finds the key gone and starts a second, forced
			// drain — which is the coordinator working, not a turn being resumed.
			yield* enqueue({ id: "msg_pending", sessionId, delivery: "steer" });

			yield* turnInFlight(sessionId);

			yield* execution.interrupt(sessionId);

			// Promotion now happens at the start of a turn, not the end: a promoted
			// prompt is already part of the conversation, and an interrupted turn
			// means the reply never came — not that the prompt was never asked.
			// (The mock previously promoted last, treating promotion as "consumed".)
			const rows = yield* delivered(sessionId);
			expect(rows.map((row) => row.id)).toEqual(["msg_pending"]);
			expect(rows[0]!.promotedSeq).not.toBeNull();
			// The injected aikit completion is synchronous in this suite, so the only
			// interruptible work in flight is the mounted sandbox command. If that
			// boundary is removed from Loop again, the assistant lands and this fails.
			const sessions = yield* Session.Service;
			expect((yield* sessions.path(sessionId)).map((item) => item.entry.type)).toEqual(["user"]);
			expect(Array.from(yield* execution.active)).toEqual([]);
		}),
	);

	itSlow(
		"a prompt admitted mid-turn stays pending when that turn is interrupted",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const inputs = yield* SessionInput.make;
			const sessionId = yield* seedSession(backend);
			yield* enqueue({ id: "msg_first", sessionId, delivery: "steer" });
			yield* turnInFlight(sessionId);

			// Admitted after this drain captured its cutoff, so it belongs to the next
			// turn. Its wake coalesces onto the active entry rather than starting one,
			// and the interrupt below clears that pending wake.
			yield* enqueue({ id: "msg_during", sessionId, delivery: "steer" });

			yield* execution.interrupt(sessionId);

			// The two halves of the rule: an interrupted turn keeps what it already
			// promoted, and what arrived after stays in the inbox rather than being
			// lost with the turn that never got to it.
			const promoted = new Map((yield* delivered(sessionId)).map((row) => [row.id, row.promotedSeq]));
			expect(promoted.get("msg_first")).not.toBeNull();
			expect(promoted.get("msg_during")).toBeNull();
			expect(yield* inputs.hasPending(sessionId, "steer")).toBe(true);

			const sessions = yield* Session.Service;
			expect((yield* sessions.path(sessionId)).map((item) => item.entry.id)).toEqual(["msg_first"]);
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
	const backend = memoryBackend();
	const options: Loop.Options = { intervalSeconds: 1, minLines: 2, maxLines: 7 };
	const count = Number(process.env.CODEWORK_LOOP_SOAK_INPUTS ?? 50);
	const { live: itSoak } = testEffect(runtime(backend, options));

	itSoak(
		`drains ${count} prompts of 2–7 seconds each`,
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession(backend);

			for (let index = 0; index < count; index++) {
				yield* enqueue({
					id: `msg_soak-${index}`,
					sessionId,
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
