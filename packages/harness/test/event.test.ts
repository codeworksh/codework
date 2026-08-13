import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventSchema } from "../src/event/schema.ts";
import { testEffect } from "./utils/effect.ts";

const layer = Layer.provideMerge(Event.layer, Database.layer(":memory:"));
const { effect: it } = testEffect(layer);

// Store-level tests declare their own events. Nothing here should depend on the
// production manifest — the store's contract is the same whatever is published
// through it, and coupling would make these tests move for unrelated reasons.
const Msg = EventSchema.define({
	type: "test.msg",
	durable: { aggregate: "aggId", version: 1 },
	schema: { aggId: Schema.String, text: Schema.String },
});

// Not in the read manifest below, so its rows leave gaps in the sequences a
// paged read walks — the case that breaks naive `hasMore` arithmetic.
const Gap = EventSchema.define({
	type: "test.gap",
	durable: { aggregate: "aggId", version: 1 },
	schema: { aggId: Schema.String },
});

const manifest = {
	definitions: EventSchema.durable([Msg]),
	schema: Schema.Union([Msg], { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type")),
};

const A = "agg_a";
const B = "agg_b";

const rowsFor = (sql: SqlClient.SqlClient, aggId: string) =>
	sql`SELECT * FROM event WHERE aggregate_id = ${aggId} ORDER BY seq`;

describe("Event store", () => {
	it("assigns sequences from 0, independently per aggregate", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const events = yield* Event.Service;

			const first = yield* events.publish(Msg, { aggId: A, text: "one" });
			const second = yield* events.publish(Msg, { aggId: A, text: "two" });
			const other = yield* events.publish(Msg, { aggId: B, text: "elsewhere" });

			expect(first.durable?.seq).toBe(0);
			expect(second.durable?.seq).toBe(1);
			expect(other.durable?.seq).toBe(0);
			expect((yield* rowsFor(sql, A)).map((r) => r.seq)).toEqual([0, 1]);
			expect(yield* events.latestSequence(A)).toBe(1);
			expect(yield* events.latestSequence(B)).toBe(0);
			expect(yield* events.latestSequence("agg_never_written")).toBe(-1);
		}));

	it("stores the versioned type while the payload keeps the bare one", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const events = yield* Event.Service;
			const published = yield* events.publish(Msg, { aggId: A, text: "one" });

			expect(published.type).toBe("test.msg");
			expect((yield* rowsFor(sql, A))[0]!.type).toBe("test.msg.1");
		}));

	it("rejects a duplicate event id", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const events = yield* Event.Service;
			const id = EventSchema.ID.create();

			yield* events.publish(Msg, { aggId: A, text: "one" }, { id });
			const exit = yield* events.publish(Msg, { aggId: A, text: "two" }, { id }).pipe(Effect.exit);

			expect(exit._tag).toBe("Failure");
			expect((yield* rowsFor(sql, A)).length).toBe(1);
		}));

	// An id is unique across the whole store, not per aggregate: reusing one
	// elsewhere would make an event ambiguous to anything that dedups by id.
	it("rejects an event id already used at another aggregate", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const events = yield* Event.Service;
			const id = EventSchema.ID.create();

			yield* events.publish(Msg, { aggId: A, text: "one" }, { id });
			const exit = yield* events.publish(Msg, { aggId: B, text: "two" }, { id }).pipe(Effect.exit);

			expect(exit._tag).toBe("Failure");
			expect((yield* rowsFor(sql, B)).length).toBe(0);
			// The rejected publish consumed no sequence at the other aggregate.
			expect(yield* events.latestSequence(B)).toBe(-1);
		}));

	// The single most important property of the store: a projector that rejects
	// an event takes the event down with it, side effects included.
	it("rolls back the event, its sequence, and projector side effects together", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const events = yield* Event.Service;
			// A probe rather than a real projection: this asserts that projector
			// writes revert, without coupling the test to any production table.
			yield* sql`CREATE TABLE IF NOT EXISTS event_probe (value TEXT NOT NULL)`;

			yield* events.project(Msg, (event) =>
				sql`INSERT INTO event_probe (value) VALUES (${event.data.text})`.pipe(Effect.orDie, Effect.asVoid),
			);
			let reject = false;
			yield* events.project(Msg, () => (reject ? Effect.die("projector rejected") : Effect.void));

			yield* events.publish(Msg, { aggId: A, text: "kept" });
			reject = true;
			const exit = yield* events.publish(Msg, { aggId: A, text: "discarded" }).pipe(Effect.exit);

			expect(exit._tag).toBe("Failure");
			expect((yield* sql`SELECT value FROM event_probe`).map((r) => r.value)).toEqual(["kept"]);
			expect((yield* rowsFor(sql, A)).length).toBe(1);
			// The sequence rolled back too, so the number is handed out again.
			expect(yield* events.latestSequence(A)).toBe(0);
			reject = false;
			expect((yield* events.publish(Msg, { aggId: A, text: "next" })).durable?.seq).toBe(1);
		}));

	it("hands the committed sequence to projectors", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const seen: number[] = [];
			yield* events.project(Msg, (event) => Effect.sync(() => void seen.push(event.durable!.seq)));

			yield* events.publish(Msg, { aggId: A, text: "one" });
			yield* events.publish(Msg, { aggId: A, text: "two" });
			expect(seen).toEqual([0, 1]);
		}));

	describe("advance", () => {
		it("starts an aggregate above a range reserved for copied state", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				yield* events.advance(A, 8);
				expect(yield* events.latestSequence(A)).toBe(8);
				expect((yield* events.publish(Msg, { aggId: A, text: "after" })).durable?.seq).toBe(9);
			}));

		it("raises the head above state written without an event", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				yield* events.publish(Msg, { aggId: A, text: "one" });
				// Something took position 5 without publishing — a copied entry, or a
				// direct write. The next event has to land above it, not collide.
				yield* events.advance(A, 5);
				expect((yield* events.publish(Msg, { aggId: A, text: "after" })).durable?.seq).toBe(6);
			}));

		it("never rewinds an aggregate that already has a log", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				yield* events.publish(Msg, { aggId: A, text: "one" });
				yield* events.publish(Msg, { aggId: A, text: "two" });

				yield* events.advance(A, 0);

				expect(yield* events.latestSequence(A)).toBe(1);
				expect((yield* events.publish(Msg, { aggId: A, text: "three" })).durable?.seq).toBe(2);
			}));
	});

	describe("readAggregate", () => {
		const publishMany = (count: number) =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				for (let i = 0; i < count; i += 1) {
					yield* events.publish(Msg, { aggId: A, text: `m${i}` });
				}
			});

		it("reads an aggregate in sequence order", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				yield* publishMany(3);

				const page = yield* events.readAggregate({ aggregateId: A, limit: 10, manifest });
				expect(page.hasMore).toBe(false);
				expect(page.events.map((e) => e.data.text)).toEqual(["m0", "m1", "m2"]);
				expect(page.events.map((e) => e.durable?.seq)).toEqual([0, 1, 2]);
			}));

		// hasMore is computed by over-reading one row, so the boundary between
		// "exactly a page" and "a page plus one" is where it goes wrong.
		it("distinguishes an exact page from a page with more behind it", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				yield* publishMany(4);

				const exact = yield* events.readAggregate({ aggregateId: A, limit: 4, manifest });
				expect(exact.events.length).toBe(4);
				expect(exact.hasMore).toBe(false);

				const partial = yield* events.readAggregate({ aggregateId: A, limit: 3, manifest });
				expect(partial.events.length).toBe(3);
				expect(partial.hasMore).toBe(true);
			}));

		it("pages past events the manifest filters out, without gaps or repeats", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				// Interleaved so the filtered rows fall inside, not after, the page.
				yield* events.publish(Msg, { aggId: A, text: "m0" });
				yield* events.publish(Gap, { aggId: A });
				yield* events.publish(Msg, { aggId: A, text: "m1" });
				yield* events.publish(Gap, { aggId: A });
				yield* events.publish(Msg, { aggId: A, text: "m2" });

				const seen: string[] = [];
				let after: number | undefined;
				let guard = 0;
				for (;;) {
					const page = yield* events.readAggregate({ aggregateId: A, after, limit: 2, manifest });
					seen.push(...page.events.map((e) => e.data.text));
					after = page.events.at(-1)?.durable?.seq;
					if (!page.hasMore || (guard += 1) > 5) break;
				}
				expect(seen).toEqual(["m0", "m1", "m2"]);
			}));

		it("excludes other aggregates", () =>
			Effect.gen(function* () {
				const events = yield* Event.Service;
				yield* events.publish(Msg, { aggId: A, text: "mine" });
				yield* events.publish(Msg, { aggId: B, text: "theirs" });

				const page = yield* events.readAggregate({ aggregateId: A, limit: 10, manifest });
				expect(page.events.map((e) => e.data.text)).toEqual(["mine"]);
			}));
	});
});
