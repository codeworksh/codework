import { Effect } from "effect";
import { appendFile, readFile } from "node:fs/promises";
import type * as Executor from "../../src/tool/executor.ts";

interface SinkEntry {
	readonly callID: string;
	readonly text: string;
}

export const fileSink =
	(path: string) =>
	(event: Executor.ProgressEvent): Effect.Effect<void> =>
		Effect.promise(() => {
			const first = event.partial.content?.[0];
			const entry: SinkEntry = { callID: event.ctx.callID, text: first?.type === "text" ? first.text : "" };
			return appendFile(path, `${JSON.stringify(entry)}\n`);
		});

export const readSink = async (path: string): Promise<SinkEntry[]> =>
	(
		await readFile(path, "utf8").catch((cause: unknown) => {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "";
			throw cause;
		})
	)
		.split("\n")
		.filter(Boolean)
		.map((raw) => JSON.parse(raw) as SinkEntry);

export const outputTextOf = (outcome: Executor.ToolOutcome): string => {
	const first = outcome.result.content[0];
	return first && first.type === "text" ? first.text : "";
};
