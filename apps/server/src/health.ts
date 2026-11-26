import { Context, Duration, Effect, Layer, Option, Queue, Schema, Semaphore, Stream, SubscriptionRef } from "effect";
import { DEFAULT_SERVER_HEALTH, ServerHealth, type ServerStatus } from "@codeworksh/contract";
import { Codework as Client } from "@codeworksh/widget/backend";
import { Cli } from "./cli.ts";
import { Codework } from "./codework.ts";
import { Kv } from "./kv.ts";
import { Servers } from "./servers.ts";
import { Sync } from "./sync.ts";

// A server started or stopped outside the app (a terminal's `codework service`) shows quickly.
const EVERY = Duration.seconds(5);
// A round trip slower than this is no answer.
const TIMED_OUT = Duration.seconds(2);

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
		const sync = yield* Sync.Service;
		const context = yield* Effect.context<Effect.Services<typeof Cli.statuses>>();
		const current = yield* SubscriptionRef.make<ReadonlyArray<ServerStatus> | undefined>(undefined);
		const lock = yield* Semaphore.make(1);
		const pokes = yield* Queue.sliding<void>(1);
		const settingsChanged = yield* Queue.sliding<void>(1);

		// One cheap call over the connection the app already holds, so timing adds no connection of its own.
		const roundTrip = (id: string) =>
			sync.client(id).pipe(
				Effect.flatMap((client) =>
					Codework.call((rpc) => rpc("server.info", {}), { timeout: TIMED_OUT }).pipe(
						Effect.provideService(Client, client),
						Effect.timed,
					),
				),
				Effect.map(([took]) => Math.round(Duration.toMillis(took))),
				Effect.orElseSucceed(() => null),
			);
		// In memory only: a round trip is as old as the check that took it.
		const trips = new Map<string, number | null>();
		// A machine not answering now has no round trip, whatever the last timing said.
		const answering = (status: ServerStatus) =>
			status.kind === "remote" ? status.online : status.server._tag === "Running";
		const withTrips = (statuses: ReadonlyArray<ServerStatus>) =>
			statuses.map((status) => ({ ...status, rtt: answering(status) ? (trips.get(status.id) ?? null) : null }));
		const timings = yield* Queue.sliding<void>(1);

		// A check never waits on a round trip: one to a machine that just stopped takes the whole timeout.
		// The statuses go out with the last ones known, and again once timed if any moved.
		const check = lock.withPermits(1)(
			Cli.statuses.pipe(
				Effect.provideContext(context),
				Effect.flatMap((statuses) => SubscriptionRef.set(current, withTrips(statuses))),
				Effect.andThen(Queue.offer(timings, undefined)),
			),
		);

		const time = Effect.gen(function* () {
			const statuses = yield* SubscriptionRef.get(current);
			if (statuses === undefined) return;
			const timed = yield* Effect.forEach(
				statuses,
				(status) => Effect.map(roundTrip(status.id), (rtt) => [status.id, rtt] as const),
				{ concurrency: "unbounded" },
			);
			const moved = timed.some(([id, rtt]) => (trips.get(id) ?? null) !== rtt);
			for (const [id, rtt] of timed) trips.set(id, rtt);
			if (moved) yield* SubscriptionRef.update(current, (now) => (now === undefined ? now : withTrips(now)));
		});

		// The default server alone is cheap to ask; only a change is worth a full check. Unless `asked`,
		// a running one is only looked for at its URL, without a call.
		const checkDefault = (asked: boolean) =>
			Effect.gen(function* () {
				const before = (yield* SubscriptionRef.get(current))?.find((status) => status.isDefault);
				if (before === undefined || before.kind === "remote") return;
				const home = servers.homeOf(yield* servers.getLocal(before.id)).path;
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
		yield* Effect.forever(Queue.take(timings).pipe(Effect.andThen(time))).pipe(Effect.forkScoped);

		// A name a server reports, a remote one going on or offline, refusing this app or answering with another key, reaches
		// Settings without waiting for the next check; the app's own edits are checked by their handlers.
		yield* servers.watch.pipe(
			Stream.map((rows) =>
				rows
					.map((row) =>
						row.kind === "remote"
							? `${row.id}=${row.host} ${row.label} ${row.version} ${row.seenAt} ${row.online} ${row.device === null} ${JSON.stringify(row.mismatch)} ${row.machineId} ${JSON.stringify(row.workspaces)}`
							: `${row.id}=${row.host}`,
					)
					.join("\n"),
			),
			Stream.changes,
			Stream.drop(1),
			Stream.runForEach(() => check),
			Effect.forkScoped,
		);

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
