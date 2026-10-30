import { Session } from "@codeworksh/harness/effect";
import { Effect, Schema } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { Client } from "../../../../server/client.ts";
import { type ThreadInfo, ThreadInfo as ThreadInfoSchema } from "../../../../server/contract.ts";
import { reportFailure } from "../../../error.ts";
import { writeJson, writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";

const origin = (info: ThreadInfo): string => {
	switch (info.origin.kind) {
		case "main":
			return "main";
		case "fork":
			return `fork of ${info.origin.threadId}`;
		case "subagent":
			return `subagent of ${info.origin.threadId}`;
	}
};

const cost = (info: ThreadInfo) => `$${info.usage.cost.toFixed(4)}`;

export default Runtime.handler(
	Cmd.commands.thread.commands.list,
	Effect.fn("CLI.thread.list")(function* ({ session, json, server }) {
		const program = Effect.gen(function* () {
			const rpc = yield* Client.make;
			const threads = yield* rpc["thread.list"]({ sessionId: Session.SessionSchema.ID.make(session) });
			if (json) return yield* writeJson(Schema.Array(ThreadInfoSchema), threads);
			if (threads.length === 0) return yield* writeOut(`No threads in ${session}.\n`);
			const rows = threads.map((info) => [
				info.id,
				origin(info),
				info.model === undefined ? "-" : `${info.model.provider}/${info.model.id}`,
				`${info.usage.input + info.usage.output} tok ${cost(info)}`,
				info.title ?? "(untitled)",
			]);
			const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
			for (const row of rows) {
				const last = row.length - 1;
				yield* writeOut(
					`${row.map((cell, column) => (column === last ? cell : cell.padEnd(widths[column] ?? 0))).join("  ")}\n`,
				);
			}
		});

		return yield* program.pipe(Effect.provide(Client.layer(server)), Effect.scoped, Effect.catch(reportFailure));
	}),
);
