import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { EventSchema } from "../src/event/schema.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { testEffect } from "./utils/effect.ts";

const layer = Layer.provideMerge(Event.layer, Database.layer(":memory:"));
const { effect: it, live: liveIt } = testEffect(layer);
const A = SessionSchema.ID.make("session_a");
const B = SessionSchema.ID.make("session_b");

const messageId = (name: string) => SessionMessageSchema.ID.make(name);

const turns = (events: Event.Interface, sessionId: SessionSchema.ID, names: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const timestamp = yield* DateTime.now;
		yield* Effect.forEach(
			names,
			(name) => events.publish(EventList.TurnEnded, { timestamp, sessionId, messageId: messageId(name) }),
			{ discard: true },
		);
	});

/**
 * A durable type defined outside `EventList`, standing in for a plugin's own.
 * The application manifest cannot name it, which is exactly the case `manifest`
 * exists for.
 */
const Foreign = EventSchema.define({
	type: "test.foreign.happened",
	durable: { aggregate: "topic", version: 1 },
	schema: { topic: Schema.String, note: Schema.String },
});
/** Just the definitions — `log` decodes each row's `data` and builds the envelope. */
const foreignDefinitions = EventSchema.durable([Foreign]);

const names = (items: ReadonlyArray<Event.LogItem>) =>
	items.flatMap((item) => (Event.isSynced(item) ? [] : [(item.data as { readonly messageId: string }).messageId]));

describe("Event.log", () => {
	liveIt("drains coalesced wakes across pages after a follower pauses", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const paused = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const expected = Array.from({ length: 250 }, (_, index) => `message_${index}`);
			const follower = yield* events.log({ aggregateId: A, follow: true }).pipe(
				Stream.tap((item) =>
					Event.isSynced(item)
						? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)))
						: Effect.void,
				),
				Stream.take(expected.length + 1),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
				Effect.forkChild,
			);
			yield* Deferred.await(paused);
			// No wake can be consumed until all three pages have committed.
			yield* turns(events, A, expected);
			yield* Deferred.succeed(resume, undefined);
			const items = Array.from(yield* Fiber.join(follower));
			expect(items[0]).toEqual({ type: "log.synced", aggregateId: A });
			expect(names(items)).toEqual(expected);
			expect(items.flatMap((item) => (Event.isSynced(item) ? [] : [item.durable?.seq]))).toEqual(
				expected.map((_, index) => index),
			);
		}),
	);

	liveIt("delivers durable events while a listener is blocked", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const synced = yield* Deferred.make<void>();
			const listening = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const follower = yield* events.log({ aggregateId: A, follow: true }).pipe(
				Stream.tap((item) => (Event.isSynced(item) ? Deferred.succeed(synced, undefined) : Effect.void)),
				Stream.take(2),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
				Effect.forkChild,
			);
			yield* Deferred.await(synced);
			yield* events.listen(() =>
				Deferred.succeed(listening, undefined).pipe(Effect.andThen(Deferred.await(release))),
			);
			const publisher = yield* turns(events, A, ["committed"]).pipe(Effect.forkChild);
			yield* Deferred.await(listening);
			// Delivery must complete before the listener is allowed to return.
			expect(names(Array.from(yield* Fiber.join(follower)))).toEqual(["committed"]);
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(publisher);
		}),
	);

	liveIt("wakes followers when a publisher is cancelled during its commit", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const synced = yield* Deferred.make<void>();
			const projecting = yield* Deferred.make<void>();
			const continueCommit = yield* Deferred.make<void>();
			const follower = yield* events.log({ aggregateId: A, follow: true }).pipe(
				Stream.tap((item) => (Event.isSynced(item) ? Deferred.succeed(synced, undefined) : Effect.void)),
				Stream.take(2),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
				Effect.forkChild,
			);
			yield* Deferred.await(synced);
			yield* events.project(EventList.TurnEnded, () =>
				Deferred.succeed(projecting, undefined).pipe(Effect.andThen(Deferred.await(continueCommit))),
			);
			const publisher = yield* turns(events, A, ["cancelled"]).pipe(Effect.forkChild);
			yield* Deferred.await(projecting);
			// Start cancellation while the transaction is paused, then let it commit.
			const interruption = yield* Fiber.interrupt(publisher).pipe(Effect.forkChild({ startImmediately: true }));
			yield* Deferred.succeed(continueCommit, undefined);
			yield* Fiber.join(interruption);
			const exit = yield* Fiber.await(publisher);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
			expect(yield* events.latestSequence(A)).toBe(0);
			expect(names(Array.from(yield* events.log({ aggregateId: A }).pipe(Stream.runCollect)))).toEqual([
				"cancelled",
			]);
			expect(names(Array.from(yield* Fiber.join(follower)))).toEqual(["cancelled"]);
		}),
	);

	it("replays an aggregate and completes at the marker", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			yield* turns(events, B, ["b"]);
			yield* turns(events, A, ["a0", "a1"]);

			const items = Array.from(yield* events.log({ aggregateId: A }).pipe(Stream.runCollect));
			expect(names(items)).toEqual(["a0", "a1"]);
			expect(items.at(-1)).toEqual({ type: "log.synced", aggregateId: A, seq: 1 });
		}));

	it("marks an empty aggregate as synced with no sequence", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const items = Array.from(yield* events.log({ aggregateId: A }).pipe(Stream.runCollect));
			expect(items).toEqual([{ type: "log.synced", aggregateId: A }]);
		}));

	it("reads after an exclusive lower bound, across pages", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			yield* turns(
				events,
				A,
				Array.from({ length: 250 }, (_, index) => `message_${index}`),
			);

			const items = Array.from(yield* events.log({ aggregateId: A, after: 247 }).pipe(Stream.runCollect));
			expect(names(items)).toEqual(["message_248", "message_249"]);

			const all = Array.from(yield* events.log({ aggregateId: A }).pipe(Stream.runCollect));
			expect(names(all)).toHaveLength(250);
			expect(all.at(-1)).toEqual({ type: "log.synced", aggregateId: A, seq: 249 });
		}));

	liveIt("appends commits after the marker and never live-only events", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			yield* turns(events, A, ["replayed"]);
			const fiber = yield* events
				.log({ aggregateId: A, follow: true })
				.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild({ startImmediately: true }));

			const timestamp = yield* DateTime.now;
			// Live-only: never stored, so it must not reach a log follower.
			yield* events.publish(EventList.LLMTextDelta, {
				timestamp,
				sessionId: A,
				messageId: messageId("live"),
				partIndex: 0,
				delta: "token",
			});
			// Another aggregate's commit must not wake this one into emitting.
			yield* turns(events, B, ["other"]);
			yield* turns(events, A, ["tailed"]);

			const items = Array.from(yield* Fiber.join(fiber));
			expect(names(items)).toEqual(["replayed", "tailed"]);
			expect(items[1]).toEqual({ type: "log.synced", aggregateId: A, seq: 0 });
		}),
	);

	liveIt("follows an aggregate whose head stands above its rows", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			// A fork reserves an inherited prefix: the head moves without rows behind
			// it, so catch-up reads nothing and the marker sits above every row.
			yield* events.advance(A, 5);
			const fiber = yield* events
				.log({ aggregateId: A, follow: true })
				.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));

			yield* turns(events, A, ["after_fork"]);

			const items = Array.from(yield* Fiber.join(fiber));
			expect(items[0]).toEqual({ type: "log.synced", aggregateId: A, seq: 5 });
			expect(names(items)).toEqual(["after_fork"]);
			expect(items[1]).toMatchObject({ durable: { aggregateId: A, seq: 6 } });
		}),
	);

	liveIt("wakes every follower on the aggregate", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const follow = () =>
				events
					.log({ aggregateId: A, follow: true })
					.pipe(
						Stream.take(2),
						Stream.runCollect,
						Effect.timeout("5 seconds"),
						Effect.forkChild({ startImmediately: true }),
					);
			const first = yield* follow();
			const second = yield* follow();

			yield* turns(events, A, ["shared"]);

			expect(names(Array.from(yield* Fiber.join(first)))).toEqual(["shared"]);
			expect(names(Array.from(yield* Fiber.join(second)))).toEqual(["shared"]);
		}),
	);

	liveIt("keeps waking the followers that remain when one leaves", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const staying = yield* events
				.log({ aggregateId: A, follow: true })
				.pipe(
					Stream.take(2),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
					Effect.forkChild({ startImmediately: true }),
				);
			// A follower that comes and goes. Its wake is released with the stream, so
			// this leaves the aggregate registered for `staying` alone -- a release
			// that dropped the whole aggregate would leave that one deaf.
			const leaving = Array.from(
				yield* events.log({ aggregateId: A, follow: true }).pipe(Stream.take(1), Stream.runCollect),
			);
			expect(leaving).toEqual([{ type: "log.synced", aggregateId: A }]);

			yield* turns(events, A, ["after_leave"]);

			expect(names(Array.from(yield* Fiber.join(staying)))).toEqual(["after_leave"]);
		}),
	);

	liveIt("delivers a commit that lands during catch-up exactly once", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			// Two pages, so catch-up is still reading when the racing commit lands.
			yield* turns(
				events,
				A,
				Array.from({ length: 101 }, (_, index) => `message_${index}`),
			);

			const replayStarted = yield* Deferred.make<void>();
			const continueReplay = yield* Deferred.make<void>();
			const seen = yield* Ref.make(0);
			const fiber = yield* events.log({ aggregateId: A, follow: true }).pipe(
				Stream.tap(
					Effect.fnUntraced(function* () {
						const index = yield* Ref.getAndUpdate(seen, (count) => count + 1);
						if (index > 0) return;
						yield* Deferred.succeed(replayStarted, undefined);
						yield* Deferred.await(continueReplay);
					}),
				),
				Stream.takeUntil(
					(item) => !Event.isSynced(item) && (item.data as { readonly messageId: string }).messageId === "racing",
				),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
				Effect.forkChild({ startImmediately: true }),
			);

			yield* Deferred.await(replayStarted);
			yield* turns(events, A, ["racing"]);
			yield* Deferred.succeed(continueReplay, undefined);

			const items = Array.from(yield* Fiber.join(fiber));
			const collected = names(items);
			expect(collected.filter((name) => name === "racing")).toEqual(["racing"]);
			// The racing commit is above the pinned watermark, so it arrives on a
			// wake after the marker rather than inside the replay.
			const marker = items.findIndex(Event.isSynced);
			expect(marker).toBe(101);
			expect(items.at(-1)).toEqual(items[102]);
			expect(collected).toHaveLength(102);
		}),
	);

	it("reads types the application manifest does not know, when given their manifest", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const topic = "plugin:test.foreign";
			yield* events.publish(Foreign, { topic, note: "one" });
			yield* events.publish(Foreign, { topic, note: "two" });

			// Without a manifest the default filter excludes the type entirely: the
			// rows are stored, and every one of them is skipped.
			const withDefault = Array.from(yield* events.log({ aggregateId: topic }).pipe(Stream.runCollect));
			expect(withDefault.filter((item) => !Event.isSynced(item))).toEqual([]);
			expect(withDefault.filter(Event.isSynced)).toHaveLength(1);

			// With the owning definitions the same rows decode.
			const withDefinitions = Array.from(
				yield* events.log({ aggregateId: topic, definitions: foreignDefinitions }).pipe(Stream.runCollect),
			);
			const notes = withDefinitions.flatMap((item) =>
				Event.isSynced(item) ? [] : [(item.data as { readonly note: string }).note],
			);
			expect(notes).toEqual(["one", "two"]);
			// The envelope is the kernel's, built from the row rather than decoded.
			const first = withDefinitions.find((item) => !Event.isSynced(item)) as Event.LogItem & {
				readonly durable?: { readonly aggregateId: string; readonly seq: number };
			};
			expect(first.durable?.aggregateId).toBe(topic);
			expect(first.durable?.seq).toBe(0);
		}));

	it("skips a row whose manifest entry is not durable instead of failing the read", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const topic = "plugin:test.foreign:nondurable";
			yield* events.publish(Foreign, { topic, note: "one" });

			// `EventSchema.durable` drops non-durable definitions, so only a hand-built manifest
			// can key one under a stored type. The row is skipped, as in opencode's Bus, rather
			// than decoded with a version nothing wrote.
			const Ephemeral = EventSchema.define({
				type: "test.foreign.happened",
				schema: { topic: Schema.String, note: Schema.String },
			});
			const handBuilt = new Map([[EventSchema.versionedType("test.foreign.happened", 1), Ephemeral]]);
			const items = Array.from(
				yield* events.log({ aggregateId: topic, definitions: handBuilt }).pipe(Stream.runCollect),
			);
			expect(items.filter((item) => !Event.isSynced(item))).toEqual([]);
			expect(items.filter(Event.isSynced)).toHaveLength(1);

			// The same row still decodes through its durable definition.
			const decoded = Array.from(
				yield* events.log({ aggregateId: topic, definitions: foreignDefinitions }).pipe(Stream.runCollect),
			);
			expect(decoded.filter((item) => !Event.isSynced(item))).toHaveLength(1);
		}));

	it("pages custom definitions across many pages and resumes from a cursor", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const topic = "plugin:test.foreign:paged";
			// Two full pages and a remainder: pagination that stopped after the first
			// page would truncate here while still emitting `Synced` at the head.
			const total = 300;
			yield* Effect.forEach(
				Array.from({ length: total }, (_, index) => index),
				(index) => events.publish(Foreign, { topic, note: `n${index}` }),
				{ discard: true },
			);

			const all = Array.from(
				yield* events.log({ aggregateId: topic, definitions: foreignDefinitions }).pipe(Stream.runCollect),
			);
			const notes = all.flatMap((item) =>
				Event.isSynced(item) ? [] : [(item.data as { readonly note: string }).note],
			);
			expect(notes).toHaveLength(total);
			expect(notes.at(0)).toBe("n0");
			expect(notes.at(-1)).toBe(`n${total - 1}`);
			// Sequences are contiguous across the page boundaries, so nothing was
			// skipped or re-read where one page hands over to the next.
			const seqs = all.flatMap((item) => (Event.isSynced(item) ? [] : [item.durable?.seq]));
			expect(seqs).toEqual(Array.from({ length: total }, (_, index) => index));

			// And a cursor resumes mid-stream rather than replaying from the start.
			const resumed = Array.from(
				yield* events
					.log({ aggregateId: topic, after: 199, definitions: foreignDefinitions })
					.pipe(Stream.runCollect),
			);
			const tail = resumed.flatMap((item) =>
				Event.isSynced(item) ? [] : [(item.data as { readonly note: string }).note],
			);
			expect(tail).toHaveLength(total - 200);
			expect(tail.at(0)).toBe("n200");
		}));

	it("leaves kernel reads on the application manifest", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			yield* turns(events, A, ["first", "second"]);
			const items = Array.from(yield* events.log({ aggregateId: A }).pipe(Stream.runCollect));
			expect(names(items)).toEqual(["first", "second"]);
		}));
});
