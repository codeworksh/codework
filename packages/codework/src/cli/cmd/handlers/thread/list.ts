import { Effect, Option, Schema } from "effect";
import * as Runtime from "../../../../framework/runtime.ts";
import * as Client from "../../../../server/client.ts";
import * as Service from "../../../service.ts";
import { type ThreadInfo, ThreadInfo as ThreadInfoSchema } from "../../../../server/contract.ts";
import { reportFailure } from "../../../error.ts";
import { sessionId } from "../../../ids.ts";
import { table, writeJson, writeOut } from "../../../output.ts";
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
		const id = yield* sessionId(session);
		const program = Effect.gen(function* () {
			const rpc = yield* Client.make;
			const threads = yield* rpc["thread.list"]({ sessionId: id });
			if (json) return yield* writeJson(Schema.Array(ThreadInfoSchema), threads);
			if (threads.length === 0) return yield* writeOut(`No threads in ${session}.\n`);
			const rows = threads.map((info) => [
				info.id,
				origin(info),
				info.model === undefined ? "-" : `${info.model.provider}/${info.model.id}`,
				`${info.usage.input + info.usage.output} tok ${cost(info)}`,
				info.title ?? "(untitled)",
			]);
			yield* writeOut(table(rows));
		});

		return yield* program.pipe(Service.connect(Option.getOrUndefined(server)), Effect.catch(reportFailure));
	}),
);
