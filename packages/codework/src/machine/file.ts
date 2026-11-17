import { Jws, Relay } from "@codeworksh/schema";
import { Effect, FileSystem, Option, Schedule, Schema } from "effect";
import { uuidv7 } from "uuidv7";

/**
 * `<home>/machine.json`: who this home is as a machine, and its link to each connected workspace.
 *
 * It survives restarts (unlike `service.json`, which a server writes and removes) and holds private
 * keys, so it is written 0600, atomically, and under a lock shared by `serve` and `codework connect`.
 */
const Link = Schema.Struct({
	name: Schema.String,
	owner: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
	key: Jws.PrivateKey,
	keyId: Schema.String,
});

export const Machine = Schema.Struct({
	id: Schema.String,
	source: Relay.IdSource,
	/** The user's own name for the machine; shown in place of the OS host name when set. */
	givenName: Schema.optional(Schema.String),
	workspaces: Schema.Record(Schema.String, Link),
});
export type Machine = typeof Machine.Type;

const json = Schema.fromJsonString(Machine);

/** `--machine-id`: lowercase letters, digits and dashes, so it reads well in every UI. */
const IdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

const write = Effect.fn("Machine.write")(function* (home: string, machine: Machine) {
	const fs = yield* FileSystem.FileSystem;
	const path = file(home);
	const temp = `${path}.${uuidv7()}.tmp`;
	yield* fs.writeFileString(temp, yield* Schema.encodeEffect(json)(machine), { mode: 0o600 });
	yield* fs.rename(temp, path);
});

/** Reads, changes and writes the machine under the lock, creating its identity on first use. */
export const update = <E, R>(
	home: string,
	options: { readonly machineId?: string | undefined },
	change: (machine: Machine) => Effect.Effect<Machine, E, R>,
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
			const next = yield* change(machine);
			yield* write(home, next);
			return next;
		}),
	);

const created = (machineId: string | undefined): Machine =>
	machineId === undefined
		? { id: uuidv7(), source: "generated", workspaces: {} }
		: { id: machineId, source: "flag", workspaces: {} };

/** Validates a `--machine-id` before anything is written. */
export const checkId = (machineId: string | undefined) =>
	machineId === undefined || IdPattern.test(machineId)
		? Effect.void
		: Effect.fail(
				new MachineError({
					message: `--machine-id must be 1-64 lowercase letters, digits or dashes, starting with a letter or digit`,
				}),
			);

export const removeLink = (home: string, workspaceId: string) =>
	update(home, {}, (machine) => {
		const { [workspaceId]: _removed, ...workspaces } = machine.workspaces;
		return Effect.succeed({ ...machine, workspaces });
	});
