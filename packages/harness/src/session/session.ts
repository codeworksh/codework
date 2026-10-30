import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import {
	type EntryState,
	entryStates,
	type EntryType,
	entryTypes,
	type MessageEntryType,
	messageEntryTypes,
	type PartType,
	partTypes,
	ProjectRow,
	SessionRow,
	SpaceRow,
	ThreadRow,
	type ToolStatus,
	toolStatuses,
} from "../db/schema.sql.ts";
import { Document } from "../document/document.ts";
import { DocumentSchema } from "../document/schema.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { ProjectSchema } from "../project/schema.ts";
import { AbsolutePath } from "../schema.ts";
import { SpaceSchema } from "../space/schema.ts";
import { Space } from "../space/space.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";
import { posix } from "../util/posix.ts";
import { Slug } from "../util/slug.ts";
import { SessionSchema } from "./schema.ts";

export {
	entryStates,
	entryTypes,
	messageEntryTypes,
	partTypes,
	SessionRow,
	toolStatuses,
	type EntryState,
	type EntryType,
	type MessageEntryType,
	type PartType,
	type ToolStatus,
};

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {}

// The space a run is placed in is gone — unreachable for a session's own while the FK holds, but a
// thread placement names its space in a document, which no FK guards. Typed so a UI can offer
// `relink` (with `--thread` for a placement) as the repair.
export class SessionLinkedSpaceNotFoundError extends Schema.TaggedError<SessionLinkedSpaceNotFoundError>()(
	"SessionLinkedSpaceNotFoundError",
	{ sessionId: Schema.String, threadId: Schema.optional(Schema.String) },
) {}

// Relink rejections: the target is not a live space, the session would cross
// projects, or an explicit directory would break the containment invariant.
export class RelinkError extends Schema.TaggedError<RelinkError>()("RelinkError", {
	sessionId: Schema.String,
	spaceId: Schema.String,
	reason: Schema.Literals([
		"space_not_found",
		"space_is_archived",
		"project_scope_mismatch",
		"directory_outside_space",
	]),
}) {}
export type RelinkReason = RelinkError["reason"];

// A directory is its space's location or sits underneath it.
const directoryWithin = (location: AbsolutePath, directory: AbsolutePath) =>
	directory === location || directory.startsWith(`${location}/`);

/**
 * Re-root a directory onto another space of the same project: the position relative to the old
 * root is kept, so `dir = /old/app/pkg/x` under `from = /old/app` lands on `/new/app/pkg/x` under
 * `to = /new/app`. A directory not under the old root — a broken invariant — lands on the new root.
 */
const rebaseDirectory = (from: AbsolutePath, to: AbsolutePath, directory: AbsolutePath): AbsolutePath => {
	if (!directoryWithin(from, directory)) return to;
	const relative = posix.relative(from, directory);
	return AbsolutePath.make(relative === "" ? to : posix.join(to, relative));
};

/**
 * An operation needed a session's host project and the session has none.
 *
 * Distinct from `SessionNotFoundError`: the session is there and is perfectly usable, it just has
 * no project to write into. That is a normal state, not corruption -- `session link` is the remedy,
 * and naming it is most of what this error is for.
 */
export class SessionNotLinkedError extends Schema.TaggedError<SessionNotLinkedError>()("SessionNotLinkedError", {
	reason: Schema.tag("session-not-linked"),
	sessionId: SessionSchema.IDFromDb,
}) {
	override get message(): string {
		return `session ${this.sessionId} is not linked to a host directory`;
	}
}

export interface CreateSession {
	readonly id?: SessionSchema.ID;
	readonly mainThreadId?: ThreadSchema.ID;
	/** The space (one directory in one env) this session attaches to; must exist. */
	readonly spaceId: SpaceSchema.ID;
	/** Absolute realpath of the cwd; equal to or under `space.location`. */
	readonly directory: AbsolutePath;
	/**
	 * The host directory this session belongs to, which its settings and plugins are discovered
	 * from. Optional, with no fallback: a session created without one has no project layer, which
	 * is a normal outcome. `link` assigns one later.
	 */
	readonly hostDir?: AbsolutePath;
	/** The main thread's title; absent = its first prompt names it. */
	readonly title?: string;
	readonly tag?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** The main thread's first `agent` value: the choices given to create. */
	readonly agent?: DocumentSchema.Agent;
}

export interface Created {
	readonly session: SessionRow;
	readonly thread: ThreadRow;
}

/** Sessions of every space of a project, or of one space. */
export type ListInput = { readonly projectId: ProjectSchema.ID } | { readonly spaceId: SpaceSchema.ID };

// The env move: point a session, or one thread, at another space of the same project (remote env
// died, repo cloned locally, worktree consolidated). Entries are untouched either way.
export interface RelinkInput {
	readonly sessionId: SessionSchema.ID;
	/** Absent moves the session's default space and directory; present sets that thread's `placement`. */
	readonly threadId?: ThreadSchema.ID;
	/** Target space; must be active and belong to the session's project. */
	readonly spaceId: SpaceSchema.ID;
	/**
	 * Landing directory; must equal or sit under the target space's location.
	 * Default: {@link Interface.rebase} onto the target space's location.
	 */
	readonly directory?: AbsolutePath;
}

/** Where a thread runs: its `agent.placement`, else the session's space and directory. */
export interface Placement {
	readonly space: SpaceSchema.Info;
	readonly directory: AbsolutePath;
}

export interface Interface {
	/** A session with its `main` thread and that thread's `agent` document, in one event. */
	readonly create: (input: CreateSession) => Effect.Effect<Created>;
	/** Projector of `session.created`. */
	readonly projectCreated: (data: EventList.SessionCreated["data"], seq: number) => Effect.Effect<void>;
	/**
	 * Point an existing session at a host directory, or clear it with `null`.
	 *
	 * Separate from `relink`, which moves where the work happens: this changes only which host
	 * project's settings and plugins the session reads.
	 */
	readonly link: (input: {
		sessionId: SessionSchema.ID;
		hostDir: AbsolutePath | null;
	}) => Effect.Effect<SessionRow, SessionNotFoundError>;
	readonly get: (sessionId: string) => Effect.Effect<Option.Option<SessionRow>>;
	/** The session's own space — its env and absolute location. None when the session is unknown. */
	readonly space: (sessionId: string) => Effect.Effect<Option.Option<SpaceSchema.Info>>;
	/** Where a thread runs. None when the thread is unknown or its space is gone. */
	readonly placement: (threadId: ThreadSchema.ID) => Effect.Effect<Option.Option<Placement>>;
	/**
	 * Where the session's directory (or the thread's placement) lands under another root, keeping
	 * its position relative to its current space's location. None when the session or thread is
	 * unknown, or its space is gone.
	 */
	readonly rebase: (input: {
		readonly sessionId: SessionSchema.ID;
		readonly threadId?: ThreadSchema.ID;
		readonly to: AbsolutePath;
	}) => Effect.Effect<Option.Option<AbsolutePath>>;
	/** The project a session belongs to, through its space. None when the session is unknown. */
	readonly project: (sessionId: string) => Effect.Effect<Option.Option<ProjectSchema.Info>>;
	/** Sessions newest first, across the whole database when no scope is given. */
	readonly list: (input?: ListInput) => Effect.Effect<SessionRow[]>;
	/**
	 * Move the session (or one thread) to another space of the same project. Without an explicit
	 * `directory` the cwd keeps its position relative to the old root; either way the result is at
	 * or under the space's location.
	 */
	readonly relink: (
		input: RelinkInput,
	) => Effect.Effect<SessionRow, SessionNotFoundError | Thread.ThreadNotFoundError | RelinkError>;
	/** Removes the session with every thread, entry, document and its event log. False when unknown. */
	readonly delete: (sessionId: SessionSchema.ID) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/session/session/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Event.Service;
		const threads = yield* Thread.Service;
		const documents = yield* Document.Service;

		const findSession = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SessionRow,
			execute: (id) => sql`SELECT * FROM session WHERE id = ${id}`,
		});

		const findSpace = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SpaceRow,
			execute: (sessionId) => sql`
				SELECT p.* FROM space p JOIN session s ON s.space_id = p.id WHERE s.id = ${sessionId}
			`,
		});

		const findProject = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: ProjectRow,
			execute: (sessionId) => sql`
				SELECT p.* FROM project p
				JOIN space sp ON sp.project_id = p.id
				JOIN session s ON s.space_id = sp.id
				WHERE s.id = ${sessionId}
			`,
		});

		const findSpaceById = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SpaceRow,
			execute: (id) => sql`SELECT * FROM space WHERE id = ${id}`,
		});

		const selectByProject = SqlSchema.findAll({
			Request: Schema.String,
			Result: SessionRow,
			execute: (projectId) => sql`
				SELECT s.* FROM session s
				JOIN space p ON p.id = s.space_id
				WHERE p.project_id = ${projectId}
				ORDER BY s.updated_at DESC
			`,
		});

		const selectBySpace = SqlSchema.findAll({
			Request: Schema.String,
			Result: SessionRow,
			execute: (spaceId) => sql`SELECT * FROM session WHERE space_id = ${spaceId} ORDER BY updated_at DESC`,
		});

		const selectAll = SqlSchema.findAll({
			Request: Schema.Void,
			Result: SessionRow,
			execute: () => sql`SELECT * FROM session ORDER BY updated_at DESC`,
		});

		const insertSession = SqlSchema.void({
			Request: SessionRow.insert,
			execute: (row) => sql`INSERT INTO session ${sql.insert(row)}`,
		});

		const epochNow = Effect.map(DateTime.now, DateTime.toEpochMillis);

		const projectCreated = Effect.fn("Session.projectCreated")(function* (
			data: EventList.SessionCreated["data"],
			seq: number,
		) {
			const row = yield* SessionRow.insert.makeEffect({
				id: data.sessionId,
				spaceId: data.spaceId,
				slug: data.slug,
				directory: data.directory,
				hostDir: Option.fromUndefinedOr(data.hostDir),
				tag: Option.fromUndefinedOr(data.tag),
				metadata: Option.fromUndefinedOr(data.metadata),
			});
			yield* insertSession(row);
			yield* threads.insert({
				id: data.threadId,
				sessionId: data.sessionId,
				origin: { kind: "main" },
				...(data.title === undefined ? {} : { title: data.title }),
				seq,
			});
			yield* documents.create({
				sessionId: data.sessionId,
				threadId: data.threadId,
				definition: DocumentSchema.agent,
				value: yield* Schema.encodeEffect(DocumentSchema.Agent)(data.agent),
				seq,
			});
		}, Effect.orDie);

		const create = Effect.fn("Session.create")(function* (input: CreateSession) {
			const id = input.id ?? SessionSchema.ID.create();
			const threadId = input.mainThreadId ?? ThreadSchema.ID.create();
			yield* events.publish(EventList.SessionCreated, {
				timestamp: yield* DateTime.now,
				sessionId: id,
				threadId,
				spaceId: input.spaceId,
				slug: yield* Slug.create(id),
				directory: input.directory,
				...(input.hostDir === undefined ? {} : { hostDir: input.hostDir }),
				...(input.tag === undefined ? {} : { tag: input.tag }),
				...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
				...(input.title === undefined ? {} : { title: input.title }),
				agent: input.agent ?? {},
			});
			const session = yield* findSession(id).pipe(Effect.orDie);
			const thread = yield* threads.get(threadId);
			if (Option.isNone(session) || Option.isNone(thread)) {
				return yield* Effect.die(new Error("session insert did not persist"));
			}
			return { session: session.value, thread: thread.value };
		});

		const get = Effect.fn("Session.get")(function* (sessionId: string) {
			return yield* findSession(sessionId).pipe(Effect.orDie);
		});

		const space = Effect.fn("Session.space")(function* (sessionId: string) {
			return Option.map(yield* findSpace(sessionId).pipe(Effect.orDie), Space.fromRow);
		});

		const placement = Effect.fn("Session.placement")(function* (threadId: ThreadSchema.ID) {
			const thread = yield* threads.get(threadId);
			if (Option.isNone(thread)) return Option.none<Placement>();
			const chosen = (yield* documents.agent(threadId)).placement;
			if (chosen !== undefined) {
				const target = yield* findSpaceById(chosen.spaceId).pipe(Effect.orDie);
				return Option.map(target, (row) => ({ space: Space.fromRow(row), directory: chosen.directory }));
			}
			const session = yield* findSession(thread.value.sessionId).pipe(Effect.orDie);
			const own = yield* space(thread.value.sessionId);
			if (Option.isNone(session) || Option.isNone(own)) return Option.none<Placement>();
			return Option.some({ space: own.value, directory: session.value.directory });
		});

		const rebase = Effect.fn("Session.rebase")(function* (input: {
			readonly sessionId: SessionSchema.ID;
			readonly threadId?: ThreadSchema.ID;
			readonly to: AbsolutePath;
		}) {
			const current: Option.Option<Placement> =
				input.threadId === undefined
					? Option.zipWith(
							yield* findSession(input.sessionId).pipe(Effect.orDie),
							yield* space(input.sessionId),
							(row, own) => ({ space: own, directory: row.directory }),
						)
					: yield* placement(input.threadId);
			return Option.map(current, (one) => rebaseDirectory(one.space.location, input.to, one.directory));
		});

		// A bare lookup has no checkout to ask, so the info carries no `vcs` (as with `Project.get`).
		const project = Effect.fn("Session.project")(function* (sessionId: string) {
			return Option.map(
				yield* findProject(sessionId).pipe(Effect.orDie),
				(row) => new ProjectSchema.Info({ id: ProjectSchema.ID.make(row.id), name: row.name, status: row.status }),
			);
		});

		const list = Effect.fn("Session.list")(function* (input?: ListInput) {
			const rows =
				input === undefined
					? selectAll()
					: "spaceId" in input
						? selectBySpace(input.spaceId)
						: selectByProject(input.projectId);
			return yield* rows.pipe(Effect.orDie);
		});

		const link = Effect.fn("Session.link")(function* (input: {
			sessionId: SessionSchema.ID;
			hostDir: AbsolutePath | null;
		}) {
			const session = yield* findSession(input.sessionId).pipe(Effect.orDie);
			if (Option.isNone(session)) return yield* new SessionNotFoundError({ sessionId: input.sessionId });
			const now = yield* epochNow;
			yield* sql`
				UPDATE session SET host_dir = ${input.hostDir}, updated_at = ${now}
				WHERE id = ${input.sessionId}
			`.pipe(Effect.orDie);
			const updated = yield* findSession(input.sessionId).pipe(Effect.orDie);
			if (Option.isNone(updated)) return yield* Effect.die(new Error("session link did not persist"));
			return updated.value;
		});

		const relink = Effect.fn("Session.relink")(function* (input: RelinkInput) {
			const reject = (reason: RelinkReason) =>
				new RelinkError({ sessionId: input.sessionId, spaceId: input.spaceId, reason });
			const session = yield* findSession(input.sessionId).pipe(Effect.orDie);
			if (Option.isNone(session)) return yield* new SessionNotFoundError({ sessionId: input.sessionId });
			if (input.threadId !== undefined) {
				const thread = yield* threads.get(input.threadId);
				if (Option.isNone(thread) || thread.value.sessionId !== input.sessionId) {
					return yield* new Thread.ThreadNotFoundError({ threadId: input.threadId });
				}
			}
			const target = yield* findSpaceById(input.spaceId).pipe(Effect.orDie);
			if (Option.isNone(target)) return yield* reject("space_not_found");
			if (target.value.status !== "active") return yield* reject("space_is_archived");
			// Same-project guard: the session's own space names the project every placement stays in.
			const own = yield* findSpace(input.sessionId).pipe(Effect.orDie);
			if (Option.isSome(own) && own.value.projectId !== target.value.projectId) {
				return yield* reject("project_scope_mismatch");
			}
			const directory =
				input.directory ??
				Option.getOrElse(
					yield* rebase({
						sessionId: input.sessionId,
						...(input.threadId === undefined ? {} : { threadId: input.threadId }),
						to: target.value.location,
					}),
					() => target.value.location,
				);
			if (!directoryWithin(target.value.location, directory)) return yield* reject("directory_outside_space");
			if (input.threadId === undefined) {
				const now = yield* epochNow;
				yield* sql`
					UPDATE session SET space_id = ${input.spaceId}, directory = ${directory}, updated_at = ${now}
					WHERE id = ${input.sessionId}
				`.pipe(Effect.orDie);
			} else {
				yield* events.publish(EventList.ThreadConfigured, {
					timestamp: yield* DateTime.now,
					sessionId: input.sessionId,
					threadId: input.threadId,
					change: { placement: { spaceId: input.spaceId, directory } },
				});
			}
			const updated = yield* findSession(input.sessionId).pipe(Effect.orDie);
			if (Option.isNone(updated)) return yield* Effect.die(new Error("session relink did not persist"));
			return updated.value;
		});

		// The log has no foreign key to the session, so both go in one transaction.
		const remove = Effect.fn("Session.delete")(function* (sessionId: SessionSchema.ID) {
			return yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const deleted = yield* sql`DELETE FROM session WHERE id = ${sessionId} RETURNING id`;
						yield* sql`DELETE FROM sequence WHERE aggregate_id = ${sessionId}`;
						return deleted.length > 0;
					}),
				)
				.pipe(Effect.orDie);
		});

		return Service.of({
			create,
			projectCreated,
			link,
			get,
			space,
			placement,
			rebase,
			project,
			list,
			relink,
			delete: remove,
		});
	}),
);

/** The session store with the thread and document stores it is built on. */
export const storeLayer = layer.pipe(Layer.provideMerge(Thread.layer), Layer.provideMerge(Document.layer));

export * as Session from "./session.ts";
