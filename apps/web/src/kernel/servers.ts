import type { ServerStatus } from "@codeworksh/contract";
import { Effect, Schedule, Stream } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";

import { Server } from "./rpc";

/** Queries answered by the default CodeWork server; they load again once it is back. */
export const codeworkKey = ["codework"];

/** Why the default server can't serve the app. */
export interface Problem {
	readonly title: string;
	/** A sentence naming the server. */
	readonly line: string;
}

/** The default server's problem from its status; undefined while the app can work with it. */
export function problemOf(status: ServerStatus): Problem | undefined {
	const { cli, server } = status;
	if (cli === null)
		return {
			title: "CodeWork Isn't Installed",
			line: "Install it, or point to it, to see your projects and sessions.",
		};
	if ("failure" in cli)
		return {
			title: "CodeWork Won't Start",
			line: `The codework executable for ${status.name} fails to run.`,
		};
	switch (server._tag) {
		case "Stopped":
			return {
				title: "Server Not Running",
				line: `${status.name} isn't running, so your projects can't load.`,
			};
		case "Unreachable":
			return {
				title: "Server Not Answering",
				line: `${status.name} is registered but doesn't reply.`,
			};
		case "Incompatible":
			return {
				title: "Incompatible Server Version",
				line: `${status.name} runs codework v${server.version}, which this app can't read.`,
			};
		case "Running":
			return undefined;
	}
}

/**
 * Every server's status, as the app server last checked it, kept current as it checks again. When
 * the default server becomes usable, whatever failed while it was not loads again.
 */
export const serversAtom = Server.runtime
	.atom(
		Stream.suspend(() => {
			let wasUsable: boolean | undefined;
			return Stream.unwrap(Server.use((client) => Effect.succeed(client("servers.watch", undefined)))).pipe(
				Stream.tap((statuses) => {
					const now = statuses.some((status) => status.isDefault && problemOf(status) === undefined);
					const recovered = wasUsable === false && now;
					wasUsable = now;
					return recovered ? Reactivity.invalidate(codeworkKey) : Effect.void;
				}),
				// The app server is local, so a dropped stream is only a moment's gap.
				Stream.retry(Schedule.spaced("1 second")),
			);
		}),
	)
	.pipe(Atom.keepAlive);

/** The default server's problem once its status is known; undefined until then, and while there is none. */
export const problemAtom = Atom.make((get) => {
	const result = get(serversAtom);
	const status = AsyncResult.isSuccess(result) ? result.value.find((candidate) => candidate.isDefault) : undefined;
	return status === undefined ? undefined : problemOf(status);
});
