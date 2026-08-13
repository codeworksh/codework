import { Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionLive } from "../src/session/live.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

// `Option` has no `.value` on the union — these tests treat a missing row as a
// bug in the code under test, not a case to handle.
const some = <A>(option: Option.Option<A>): A => Option.getOrThrow(option);


/**
 * Volume and concurrency over the whole Stage 1 + 2 chain: prompt -> event ->
 * inbox -> promote -> entry. The unit suites each pin one hop; this asserts the
 * invariants that only appear across a long run — that the log stays contiguous,
 * that no prompt is lost or delivered twice, and that the tree and the inbox
 * agree on every position.
 *
 * The sandbox is deliberately absent: `runner.loop.test.ts` covers the shell
 * side, and dragging it in here would make the flow harder to see, not safer.
 */
const layer = SessionLive.layer.pipe(
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(Database.layer(":memory:")),
);
const { effect: it } = testEffect(layer);

const lorem = [
	"lorem ipsum dolor sit amet",
	"consectetur adipiscing elit sed do",
	"eiusmod tempor incididunt ut labore",
	"et dolore magna aliqua ut enim",
	"ad minim veniam quis nostrud",
];
const promptAt = (index: number) => PromptSchema.Prompt.make({ text: `${index}: ${lorem[index % lorem.length]}` });

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		projectId: "local",
		slug: "flow",
		directory: AbsolutePath.make("/repo"),
		title: "T",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
	return { sessions, inputs: yield* SessionInput.make, events: yield* Event.Service, sessionId: session.id };
});

/**
 * The lane policy `Loop.run` applies, without the sandbox: capture the cutoff
 * before promoting, drain steers first, take one follow-up per pass, and stop
 * when a pass promotes nothing.
 */
const drain = (
	sessionId: SessionSchema.ID,
	inputs: SessionInput.Interface,
	events: Event.Interface,
) =>
	Effect.gen(function* () {
		const passes: number[] = [];
		for (;;) {
			const cutoff = yield* events.latestSequence(sessionId);
			let promoted = yield* inputs.promoteSteers(sessionId, cutoff);
			if (promoted === 0 && (yield* inputs.hasPending(sessionId, "followUp"))) {
				promoted += Number(yield* inputs.promoteFollowUp(sessionId));
			}
			if (promoted === 0) break;
			passes.push(promoted);
			// Stands in for the turn a real loop would run here.
			yield* Effect.yieldNow;
		}
		return passes;
	});

const eventSeqs = Effect.fnUntraced(function* (sessionId: string) {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql`SELECT seq FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq`;
	return rows.map((row) => row.seq as number);
});

describe("Stage 1 + 2 flow", () => {
	it("carries 17 prompts through admit, promote, and append without losing one", () =>
		Effect.gen(function* () {
			const { sessions, inputs, events, sessionId } = yield* setup;
			const count = 17;

			const admitted = [];
			for (let index = 0; index < count; index += 1) {
				admitted.push(
					yield* sessions.prompt({
						sessionId,
						prompt: promptAt(index),
						// Roughly a third arrive as follow-ups.
						delivery: index % 3 === 2 ? "followUp" : "steer",
					}),
				);
			}

			// Admission alone puts nothing in the conversation.
			expect(yield* sessions.path(sessionId)).toEqual([]);
			expect(admitted.map((a) => a.admittedSeq)).toEqual(Array.from({ length: count }, (_, i) => i));

			const passes = yield* drain(sessionId, inputs, events);

			// Steers go as one batch; each follow-up needs its own pass.
			const followUps = admitted.filter((a) => a.delivery === "followUp").length;
			expect(passes.length).toBe(1 + followUps);
			expect(passes.reduce((a, b) => a + b, 0)).toBe(count);

			// Every prompt was delivered exactly once.
			const settled = yield* Effect.forEach(admitted, (a) => inputs.find(a.id));
			expect(settled.every((row) => some(row).promotedSeq !== undefined)).toBe(true);
			const promotedSeqs = settled.map((row) => some(row).promotedSeq!);
			expect(new Set(promotedSeqs).size).toBe(count);

			// The log is one contiguous run: admissions, then promotions, no gaps.
			const seqs = yield* eventSeqs(sessionId);
			expect(seqs).toEqual(Array.from({ length: count * 2 }, (_, i) => i));

			// The tree and the inbox agree on every position, which is only true
			// because both are drawn from the same sequence.
			const path = yield* sessions.path(sessionId);
			expect(path.length).toBe(count);
			const byPromotion = [...settled].sort((a, b) => some(a).promotedSeq! - some(b).promotedSeq!);
			expect(path.map((h) => h.entry.id)).toEqual(byPromotion.map((row) => some(row).id));
			expect(path.map((h) => h.entry.seq)).toEqual(byPromotion.map((row) => some(row).promotedSeq));

			// Positions strictly ascend along the path, which is what selectPath's
			// ORDER BY relies on to return root-first.
			const entrySeqs = path.map((h) => h.entry.seq);
			expect(entrySeqs.every((seq, i) => i === 0 || seq > entrySeqs[i - 1]!)).toBe(true);

			// Text survived the Prompt -> aikit envelope -> part round trip.
			expect(JSON.parse(path[0]!.parts[0]!.data)).toMatchObject({
				type: "text",
				text: some(byPromotion[0]!).prompt.text,
			});

			// The inbox is drained, so a further drain is a no-op.
			expect(yield* inputs.hasPending(sessionId, "steer")).toBe(false);
			expect(yield* inputs.hasPending(sessionId, "followUp")).toBe(false);
			expect(yield* drain(sessionId, inputs, events)).toEqual([]);
		}));

	// The case the cutoff exists for: a prompt admitted while a drain is running
	// must not join the batch that drain already decided on.
	it("holds a steer admitted mid-drain until the next pass", () =>
		Effect.gen(function* () {
			const { sessions, inputs, events, sessionId } = yield* setup;
			const before = yield* sessions.prompt({ sessionId, prompt: promptAt(0) });

			// Interleaved on the runtime rather than sequenced: the injected prompt
			// lands while the drain fiber is between its own suspension points.
			const draining = yield* Effect.forkChild(drain(sessionId, inputs, events));
			const during = yield* sessions.prompt({ sessionId, prompt: promptAt(1) });
			yield* Fiber.join(draining);

			expect(some(yield* inputs.find(before.id)).promotedSeq).toBeDefined();
			// Whichever side won the race, the outcome is the same shape: a prompt is
			// either promoted by this drain or still pending for the next one, never
			// half-delivered and never delivered twice.
			const injected = some(yield* inputs.find(during.id));
			const path = yield* sessions.path(sessionId);
			if (injected.promotedSeq === undefined) {
				expect(path.map((h) => h.entry.id)).toEqual([before.id]);
				expect(yield* inputs.hasPending(sessionId, "steer")).toBe(true);

				// And the next drain picks it up, above everything already there.
				yield* drain(sessionId, inputs, events);
				const after = yield* sessions.path(sessionId);
				expect(after.map((h) => h.entry.id)).toEqual([before.id, during.id]);
				expect(after[1]!.entry.seq).toBeGreaterThan(after[0]!.entry.seq);
				return;
			}
			expect(path.map((h) => h.entry.id)).toEqual([before.id, during.id]);
			expect(yield* inputs.hasPending(sessionId, "steer")).toBe(false);
		}));

	it("keeps two sessions' logs and trees independent under interleaved prompts", () =>
		Effect.gen(function* () {
			const { sessions, inputs, events, sessionId } = yield* setup;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO session (id, project_id, slug, directory, title, tag, sandbox_instance_id, created_at, updated_at)
				VALUES ('ses_other', 'local', 'other', '/repo', 'T', 'test', NULL, 0, 0)
			`;
			const other = SessionSchema.ID.make("ses_other");

			for (let index = 0; index < 6; index += 1) {
				yield* sessions.prompt({ sessionId, prompt: promptAt(index) });
				yield* sessions.prompt({ sessionId: other, prompt: promptAt(index) });
			}

			yield* drain(sessionId, inputs, events);

			// Each aggregate numbers from 0 regardless of the other's traffic.
			expect(yield* eventSeqs(sessionId)).toEqual(Array.from({ length: 12 }, (_, i) => i));
			expect(yield* eventSeqs(other)).toEqual([0, 1, 2, 3, 4, 5]);
			expect((yield* sessions.path(sessionId)).length).toBe(6);
			// The other session was never drained, so nothing reached its tree.
			expect(yield* sessions.path(other)).toEqual([]);
			expect(yield* inputs.hasPending(other, "steer")).toBe(true);
		}));
});
