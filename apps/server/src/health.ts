import { Context, Duration, Effect, Layer, Option, Queue, Schema, Semaphore, Stream, SubscriptionRef } from "effect";
import { DEFAULT_SERVER_HEALTH, ServerHealth, type ServerStatus } from "@codeworksh/contract";
import { Cli } from "./cli.ts";
import { Kv } from "./kv.ts";
import { Servers } from "./servers.ts";

// A server started or stopped outside the app (a terminal's `codework service`) shows quickly.
const EVERY = Duration.seconds(5);

const decodeHealth = Schema.decodeUnknownOption(ServerHealth);
const store = { package: "@codeworksh/server", key: "health" };

/**
 * The servers' status, held so every reader sees the same one: checked at launch, every `interval`,
 * after anything the app changes, and soon after a call to the default server fails. The default
 * server's process is also looked for every few seconds, so it going or coming shows at once.
 */
export class Service extends Context.Service<
	Service,
	{
		/** The statuses as last checked, then each change. */
		readonly changes: Stream.Stream<ReadonlyArray<ServerStatus>>;
		/** Checks every server again; done once the new statuses are out. */
		readonly check: Effect.Effect<void>;
		/** Checks the default server soon, as after a call to it failed. */
		readonly poke: Effect.Effect<void>;
		readonly settings: Effect.Effect<ServerHealth>;
		readonly setSettings: (settings: ServerHealth) => Effect.Effect<void>;
	}
>()("@codeworksh/server/health/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const kv = yield* Kv.Service;
		const servers = yield* Servers.Service;
		const context = yield* Effect.context<Effect.Services<typeof Cli.statuses>>();
		const current = yield* SubscriptionRef.make<ReadonlyArray<ServerStatus> | undefined>(undefined);
		const lock = yield* Semaphore.make(1);
		const pokes = yield* Queue.sliding<void>(1);
		const settingsChanged = yield* Queue.sliding<void>(1);

		const check = lock.withPermits(1)(
			Cli.statuses.pipe(
				Effect.provideContext(context),
				Effect.flatMap((statuses) => SubscriptionRef.set(current, statuses)),
			),
		);

		// The default server alone is cheap to ask; only a change is worth a full check. Unless `asked`,
		// a running one is only looked for, without a call.
		const checkDefault = (asked: boolean) =>
			Effect.gen(function* () {
				const before = (yield* SubscriptionRef.get(current))?.find((status) => status.isDefault);
				if (before === undefined) return;
				const home = servers.homeOf(yield* servers.get(before.id)).path;
				if (!asked && before.server._tag === "Running") {
					const live = yield* Cli.liveAt(home).pipe(Effect.provideContext(context));
					if (Option.isNone(live)) yield* check;
					return;
				}
				const now = yield* Cli.serverAt(home, true).pipe(Effect.provideContext(context));
				if (now._tag !== before.server._tag) yield* check;
			}).pipe(Effect.ignore);

		const settings = kv
			.get(store.package, store.key)
			.pipe(
				Effect.map((saved) => Option.getOrElse(Option.flatMap(saved, decodeHealth), () => DEFAULT_SERVER_HEALTH)),
			);

		yield* check.pipe(Effect.forkScoped);

		// Every interval; a new interval starts counting at once, and 0 waits for one.
		yield* Effect.forever(
			Effect.gen(function* () {
				const { interval } = yield* settings;
				const changed = Queue.take(settingsChanged).pipe(Effect.as(false));
				const elapsed = yield* interval === 0
					? changed
					: Effect.raceFirst(Effect.sleep(Duration.seconds(interval)).pipe(Effect.as(true)), changed);
				if (elapsed) yield* check;
			}),
		).pipe(Effect.forkScoped);

		yield* Effect.forever(
			Effect.gen(function* () {
				const poked = yield* Queue.take(pokes).pipe(Effect.timeoutOption(EVERY));
				yield* checkDefault(Option.isSome(poked));
			}),
		).pipe(Effect.forkScoped);

		return Service.of({
			changes: SubscriptionRef.changes(current).pipe(
				Stream.filter((statuses): statuses is ReadonlyArray<ServerStatus> => statuses !== undefined),
			),
			check,
			poke: Queue.offer(pokes, undefined).pipe(Effect.asVoid),
			settings,
			setSettings: Effect.fn("Health.setSettings")(function* (next) {
				yield* kv.set(store.package, store.key, next);
				yield* Queue.offer(settingsChanged, undefined);
			}),
		});
	}),
);

export * as Health from "./health.ts";
