import { Effect, Option } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Client from "../../../../server/client.ts";
import * as Service from "../../../service.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { sessionId, threadFlag } from "../../../ids.ts";
import { Cmd } from "../../cmd.ts";
import { describe, MARKS } from "./shared.ts";

/**
 * `reconnect` and `disconnect`: one RPC on a thread's server in a running server, which acts on the
 * instance every thread sharing it uses. Exits 1 when the server did not end up as asked.
 */
const control = (operation: "connect" | "disconnect") =>
	Effect.fn(`CLI.mcp.${operation}`)(function* ({
		name,
		session,
		thread,
		server,
	}: {
		readonly name: string;
		readonly session: string;
		readonly thread: Option.Option<string>;
		readonly server: Option.Option<string>;
	}) {
		const id = yield* sessionId(session);
		const program = Effect.gen(function* () {
			const threadId = yield* threadFlag(thread);
			const rpc = yield* Client.make;
			const status = yield* rpc[`mcp.${operation}`]({
				sessionId: id,
				...(threadId === undefined ? {} : { threadId }),
				server: name,
			});
			const lines = [
				`${MARKS[status.state]} ${status.server}  ${describe(status.state, status.tools.length, status.skipped)}`,
			];
			if (status.error !== undefined) for (const line of status.error.split("\n")) lines.push(`    ${line}`);
			yield* writeOut(`${lines.join("\n")}\n`);
			if (status.state !== (operation === "connect" ? "connected" : "disconnected")) process.exitCode = 1;
		});
		return yield* program.pipe(Service.connect(Option.getOrUndefined(server)), Effect.catch(reportFailure));
	});

export const reconnect = Runtime.handler(Cmd.commands.mcp.commands.reconnect, control("connect"));
export const disconnect = Runtime.handler(Cmd.commands.mcp.commands.disconnect, control("disconnect"));
