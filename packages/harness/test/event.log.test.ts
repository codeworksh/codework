import { DateTime, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
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

const names = (items: ReadonlyArray<Event.LogItem>) =>
	items.flatMap((item) => (Event.isSynced(item) ? [] : [(item.data as { readonly messageId: string }).messageId]));

describe("Event.log", () => {
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
});
