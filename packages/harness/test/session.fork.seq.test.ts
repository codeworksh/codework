import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const layer = Session.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const { effect: it } = testEffect(layer);

const entry = (sessionId: SessionSchema.ID, id: string, seq: number): Session.AppendEntry => ({
	id,
	sessionId,
	seq,
	type: "user",
	data: JSON.stringify({ messageId: id, role: "user", time: { created: 1 } }),
	parts: [{ type: "text", data: JSON.stringify({ type: "text", text: id }) }],
});

const seed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const session = yield* Session.Service;
	return yield* session.create({
		projectId: "local",
		slug: "src",
		directory: AbsolutePath.make("/repo"),
		title: "T",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
});

describe("fork sequence seeding", () => {
	it("seeds the new aggregate above the copied entries and records the fork", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const events = yield* Event.Service;
			const source = yield* seed;

			// Sparse positions, as a real log produces.
			yield* session.append(entry(source.id, "e1", 1));
			yield* session.append(entry(source.id, "e2", 4));
			yield* session.append(entry(source.id, "e3", 9));

			const fork = yield* session.fork({ sessionId: source.id, slug: "forked" });

			// The seeded position is the highest copied entry, not 0.
			expect(yield* events.latestSequence(fork.id)).toBe(10);

			const forked = yield* sql`SELECT * FROM event WHERE aggregate_id = ${fork.id}`;
			expect(forked.length).toBe(1);
			expect(forked[0]!.type).toBe("session.next.forked.1");
			expect(forked[0]!.seq).toBe(10);
			expect(JSON.parse(forked[0]!.data as string).baseSeq).toBe(9);

			// The source's own log is untouched by the fork.
			expect(yield* events.latestSequence(source.id)).toBe(-1);
		}));

	it("a real append after the fork lands above the copy", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const events = yield* Event.Service;
			const source = yield* seed;
			yield* session.append(entry(source.id, "e1", 1));
			yield* session.append(entry(source.id, "e2", 6));

			const fork = yield* session.fork({ sessionId: source.id, slug: "forked" });
			const next = yield* events.latestSequence(fork.id);
			yield* session.append(entry(fork.id, "f1", next + 1));

			const path = yield* session.path(fork.id);
			const seqs = path.map((h) => h.entry.seq);
			expect(seqs).toEqual([1, 6, next + 1]);
			// parent.seq < child.seq, which selectPath orders by
			expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
		}));

	// Positions arrive from outside now, so the tree can no longer derive the
	// guarantee that they advance -- it has to enforce it. Left unchecked, a
	// stale position fails silently: `selectPath` orders by seq, so the child
	// would sort above its own parent.
	it("append rejects a position that does not advance", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* seed;
			yield* session.append(entry(source.id, "e1", 5));

			const stale = yield* session.append(entry(source.id, "e2", 2)).pipe(Effect.flip);
			expect(stale._tag).toBe("InvalidEntryDataError");

			// Equal is not advancing either, and it must fail the same way rather
			// than surfacing as a raw unique-index violation.
			const same = yield* session.append(entry(source.id, "e3", 5)).pipe(Effect.flip);
			expect(same._tag).toBe("InvalidEntryDataError");

			// Nothing was written; the path is untouched.
			const path = yield* session.path(source.id);
			expect(path.map((h) => h.entry.id)).toEqual(["e1"]);

			// And a position that does advance still works.
			yield* session.append(entry(source.id, "e4", 6));
			expect((yield* session.path(source.id)).map((h) => h.entry.seq)).toEqual([5, 6]);
		}));
});
