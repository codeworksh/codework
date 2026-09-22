import { Database, Event, Global, Session, SessionStore } from "@codeworksh/harness/effect";
import { Effect, Layer, Option } from "effect";

/**
 * The host directory a session is linked to.
 *
 * **A session ID can answer this and a project ID cannot**, which is why the flag takes one. A
 * `Project` is env-independent by design -- its identity is a repo marker, a remote hash or a root
 * commit, never a path -- and its spaces hold `location`s *inside* an env, which may be a container
 * on another machine. Deriving a host settings file from one would mean walking the host
 * filesystem from a path that means something somewhere else, which is the exact failure the
 * `hostDir` split exists to prevent: it does not error, it finds a stranger's project.
 *
 * A session, by contrast, carries a `hostDir` that was *declared* on the host. Absent is a normal
 * state rather than corruption, and it is the one this refuses.
 */
export const linkedDirectory = Effect.fn("CLI.plugin.linkedDirectory")(function* (
	sessionId: string,
	home: Option.Option<string>,
) {
	const paths = yield* Global.resolve(Option.isNone(home) ? {} : { home: home.value });
	const id = Session.SessionSchema.ID.ascending(sessionId);

	return yield* Effect.gen(function* () {
		const sessions = yield* SessionStore.Service;
		const found = yield* sessions.get(id);
		if (Option.isNone(found)) return yield* new SessionStore.SessionNotFoundError({ sessionId: id });
		const hostDir = Option.getOrUndefined(found.value.hostDir);
		if (hostDir === undefined) return yield* new SessionStore.SessionNotLinkedError({ sessionId: id });
		return hostDir;
	}).pipe(
		// Only the session row is read, so this needs the database and the event log the store is
		// built on -- no sandboxes, no control plane, no plugin machinery.
		Effect.provide(
			SessionStore.layer.pipe(
				Layer.provide(Event.layer),
				Layer.provide(Database.layer(yield* Database.path(paths.data))),
			),
		),
	);
});
