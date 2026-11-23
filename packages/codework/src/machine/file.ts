import { Jws, Relay } from "@codeworksh/schema";
import { Effect, FileSystem, Option, Schedule, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import * as Private from "../framework/private.ts";

/**
 * `<home>/machine.json`: who this home is as a machine, and its link to each connected workspace.
 *
 * It survives restarts (unlike `service.json`, which a server writes and removes) and holds private
 * keys, so it is written 0600, atomically, and under a lock shared by `serve` and `codework connect`.
 */
const Link = Schema.Struct({
	name: Schema.String,
	owner: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
	/** The relay the link was made with; heartbeats and disconnect go there. */
	relay: Schema.String,
	key: Jws.PrivateKey,
	keyId: Schema.String,
	/** Left locally, but the relay hasn't confirmed: the key is kept to revoke it once the relay answers. */
	leaving: Schema.optionalKey(Schema.Boolean),
});

/** One key per home, vouching for each link key, so the relay knows every link of this home is one machine. */
const Identity = Schema.Struct({ key: Jws.PrivateKey, keyId: Schema.String });
type Identity = typeof Identity.Type;

export const Machine = Schema.Struct({
	id: Schema.String,
	source: Relay.IdSource,
	/** The user's own name for the machine; shown in place of the OS host name when set. */
	givenName: Schema.optional(Schema.String),
	// Optional only for homes connected before identities existed; `update` gives every home one.
	identity: Schema.optional(Identity),
	workspaces: Schema.Record(Schema.String, Link),
});
export type Machine = typeof Machine.Type;
/** The machine as {@link update} hands it out: always with its identity. */
type Identified = Machine & { readonly identity: Identity };

const json = Schema.fromJsonString(Machine);

class MachineError extends Schema.TaggedError<MachineError>()("Machine.MachineError", {
	message: Schema.String,
}) {}

const file = (home: string) => `${home}/machine.json`;

/** The machine as stored, or none before its first run. */
export const read = Effect.fn("Machine.read")(function* (home: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = file(home);
	if (!(yield* fs.exists(path))) return Option.none<Machine>();
	const text = yield* fs.readFileString(path);
	return Option.some(
		yield* Schema.decodeEffect(json)(text).pipe(
			Effect.mapError(() => new MachineError({ message: `${path} is not a valid machine file` })),
		),
	);
});

// One writer at a time: creating a directory either succeeds or fails, so it serves as a lock.
const locked = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const lock = `${file(home)}.lock`;
		yield* fs.makeDirectory(home, { recursive: true });
		yield* fs.makeDirectory(lock).pipe(
			Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
			Effect.mapError(() => new MachineError({ message: `${lock} is held by another process` })),
		);
		return yield* effect.pipe(Effect.ensuring(fs.remove(lock, { recursive: true }).pipe(Effect.ignore)));
	});

const write = (home: string, machine: Machine) =>
	Schema.encodeEffect(json)(machine).pipe(Effect.flatMap((encoded) => Private.write(file(home), encoded)));

const newIdentity = Effect.gen(function* () {
	const key = yield* Jws.generate();
	return { key, keyId: yield* Jws.thumbprint(Jws.publicOf(key)) } satisfies Identity;
});

/** Reads, changes and writes the machine under the lock, creating its identity on first use. */
export const update = <E, R>(
	home: string,
	options: { readonly machineId?: string | undefined },
	change: (machine: Identified) => Effect.Effect<Identified, E, R>,
) =>
	locked(
		home,
		Effect.gen(function* () {
			const existing = yield* read(home);
			const machine = yield* Option.match(existing, {
				onNone: () => Effect.succeed(created(options.machineId)),
				onSome: (machine) =>
					options.machineId === undefined || options.machineId === machine.id
						? Effect.succeed(machine)
						: Effect.fail(
								new MachineError({
									message: `This home is machine ${machine.id}; its id can't change to ${options.machineId}. Use another --home.`,
								}),
							),
			});
			const identity = machine.identity ?? (yield* newIdentity);
			const next = yield* change({ ...machine, identity });
			yield* write(home, next);
			return next;
		}),
	);

/** The home's identity, created with the machine on first use. */
export const identity = Effect.fn("Machine.identity")(function* (home: string) {
	const stored = yield* read(home);
	if (Option.isSome(stored) && stored.value.identity !== undefined) return stored.value.identity;
	return (yield* update(home, {}, Effect.succeed)).identity;
});

const created = (machineId: string | undefined): Machine =>
	machineId === undefined
		? { id: uuidv7(), source: "generated", workspaces: {} }
		: { id: machineId, source: "flag", workspaces: {} };

/** Validates a `--machine-id` before anything is written. */
export const checkId = (machineId: string | undefined) =>
	machineId === undefined || Schema.is(Relay.MachineId)(machineId)
		? Effect.void
		: Effect.fail(
				new MachineError({
					message: `--machine-id must be 1-64 lowercase letters, digits or dashes, starting with a letter or digit`,
				}),
			);

/**
 * Forgets the link to a workspace, only while it still holds `keyId`: a reconnect that saved a new key in
 * the meantime keeps its link.
 */
export const removeLink = (home: string, workspaceId: string, keyId: string) =>
	update(home, {}, (machine) => {
		const { [workspaceId]: link, ...workspaces } = machine.workspaces;
		return Effect.succeed(link === undefined || link.keyId !== keyId ? machine : { ...machine, workspaces });
	});

/** Marks the link as leaving, only while it still holds `keyId`. */
export const markLeaving = (home: string, workspaceId: string, keyId: string) =>
	update(home, {}, (machine) => {
		const link = machine.workspaces[workspaceId];
		return Effect.succeed(
			link === undefined || link.keyId !== keyId
				? machine
				: { ...machine, workspaces: { ...machine.workspaces, [workspaceId]: { ...link, leaving: true } } },
		);
	});
