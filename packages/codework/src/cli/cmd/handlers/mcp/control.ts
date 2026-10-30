import { Session } from "@codeworksh/harness/effect";
import { Effect, Schema } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { Client } from "../../../../server/client.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { describe, MARKS } from "./shared.ts";

const isThreadId = Schema.is(Session.ThreadSchema.ID);

/**
 * `reconnect` and `disconnect`: one RPC on a thread's server in a running server, which acts on the
 * instance every thread sharing it uses. Exits 1 when the server did not end up as asked.
 */
export const control = (operation: "connect" | "disconnect") =>
	Effect.fn(`CLI.mcp.${operation}`)(function* ({
		name,
		threadId,
		server,
	}: {
		readonly name: string;
		readonly threadId: string;
		readonly server: string;
	}) {
		const program = Effect.gen(function* () {
			if (!isThreadId(threadId))
				return yield* new InvalidInputError({ message: "--threadId takes a thread ID (thr_…)" });
			const rpc = yield* Client.make;
			const status = yield* rpc[`mcp.${operation}`]({ threadId, server: name });
			const lines = [`${MARKS[status.state]} ${status.server}  ${describe(status.state, status.tools.length)}`];
			if (status.error !== undefined) for (const line of status.error.split("\n")) lines.push(`    ${line}`);
			yield* writeOut(`${lines.join("\n")}\n`);
			if (status.state !== (operation === "connect" ? "connected" : "disconnected")) process.exitCode = 1;
		});
		return yield* program.pipe(Effect.provide(Client.layer(server)), Effect.scoped, Effect.catch(reportFailure));
	});

export const reconnect = Runtime.handler(Cmd.commands.mcp.commands.reconnect, control("connect"));
export const disconnect = Runtime.handler(Cmd.commands.mcp.commands.disconnect, control("disconnect"));
