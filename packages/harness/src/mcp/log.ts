import type { LoggingMessageNotificationParams } from "@modelcontextprotocol/client";
import { DateTime, Effect, Semaphore } from "effect";
import { fileSystem, hostPath } from "../host.ts";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const formatData = (data: unknown): string => {
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data) ?? String(data);
	} catch {
		return String(data);
	}
};

/** One `notifications/message` from `server` as a log line; continuation lines are indented. */
export const format = (server: string, params: LoggingMessageNotificationParams, now: DateTime.Utc): string => {
	const logger = params.logger ? ` ${params.logger}:` : "";
	const text = formatData(params.data).replace(/\r?\n/g, "\n    ");
	return `${DateTime.formatIso(now)} [${server}] ${params.level}${logger} ${text}\n`;
};

/**
 * Appends server log messages to one file, rotated to `<path>.1` once it grows past 5 MB. Several
 * processes may write to the same file, so the size is re-read before rotating. Write errors are
 * ignored: logging must not break tools.
 */
export const make = Effect.fn("McpLog.make")(function* (path: string) {
	const lock = yield* Semaphore.make(1);
	let size: number | undefined;
	const current = fileSystem.stat(path).pipe(
		Effect.map((info) => Number(info.size)),
		Effect.orElseSucceed(() => 0),
	);

	const write = (server: string, params: LoggingMessageNotificationParams) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const line = format(server, params, yield* DateTime.now);
				if (size === undefined) {
					yield* fileSystem.makeDirectory(hostPath.dirname(path), { recursive: true });
					size = yield* current;
				}
				if (size > MAX_LOG_BYTES) {
					// Another process may have rotated it already; check before renaming.
					if ((yield* current) > MAX_LOG_BYTES) yield* fileSystem.rename(path, `${path}.1`);
					size = yield* current;
				}
				yield* fileSystem.writeFileString(path, line, { flag: "a" });
				size += Buffer.byteLength(line);
			}).pipe(Effect.ignore),
		);

	return { path, write };
});

export * as McpLog from "./log.ts";
