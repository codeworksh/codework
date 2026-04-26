import { Global } from "../config/global.ts";
import { type Static, Type } from "@sinclair/typebox";
import fastJson from "fast-json-stringify";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Glob } from "@codeworksh/utils";

export namespace Log {
	export const Level = Type.Enum(
		{
			DEBUG: "DEBUG",
			INFO: "INFO",
			WARN: "WARN",
			ERROR: "ERROR",
		},
		{ title: "LogLevel" },
	);
	export type Level = Static<typeof Level>;

	const stringifyExtra = fastJson({
		type: "object",
		additionalProperties: true, // Allows dynamic tags/extra fields
	});

	const levelPriority: Record<Level, number> = {
		DEBUG: 0,
		INFO: 1,
		WARN: 2,
		ERROR: 3,
	};

	let level: Level = "INFO";

	function shouldLog(input: Level): boolean {
		return levelPriority[input] >= levelPriority[level];
	}

	export type Logger = {
		debug(message?: any, extra?: Record<string, any>): void;
		info(message?: any, extra?: Record<string, any>): void;
		error(message?: any, extra?: Record<string, any>): void;
		warn(message?: any, extra?: Record<string, any>): void;
		tag(key: string, value: string): Logger;
		clone(): Logger;
		time(
			message: string,
			extra?: Record<string, any>,
		): {
			stop(): void;
			[Symbol.dispose](): void;
		};
	};

	const loggers = new Map<string, Logger>();

	export interface Options {
		print: boolean;
		dev?: boolean;
		level?: Level;
	}

	let logpath = "";
	export function file() {
		return logpath;
	}

	let write = (msg: string) => {
		process.stderr.write(msg);
	};

	export async function init(options: Options) {
		if (options.level) level = options.level;

		// Ensure log directory exists
		await fs.mkdir(Global.Path.log, { recursive: true }).catch(() => {});

		await cleanup(Global.Path.log);

		if (options.print) return;

		logpath = path.join(
			Global.Path.log,
			options.dev ? "dev.log" : `${(new Date().toISOString().split(".")[0] ?? "").replace(/:/g, "")}.log`,
		);

		// Ensure file exists and is empty
		await fs.writeFile(logpath, "").catch(() => {});

		const stream = createWriteStream(logpath, { flags: "a" });
		write = (msg: string) => {
			stream.write(msg);
		};
	}

	async function cleanup(dir: string) {
		try {
			const files = await Glob.scan("????-??-??T??????.log", {
				cwd: dir,
				absolute: true,
				include: "file",
			});
			if (files.length <= 5) return;

			files.sort();
			const filesToDelete = files.slice(0, -10);
			await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})));
		} catch {
			// Ignore cleanup errors
		}
	}

	function formatError(error: any, depth = 0): string {
		if (!(error instanceof Error)) return String(error);

		let result = error.stack || error.message;
		if (error.cause instanceof Error && depth < 10) {
			result += `\nCaused by: ${formatError(error.cause, depth + 1)}`;
		}
		return result;
	}

	let last = Date.now();

	export function create(initialTags?: Record<string, any>): Logger {
		const tags = { ...initialTags };

		const service = tags.service;
		if (service && typeof service === "string") {
			const cached = loggers.get(service);
			if (cached) {
				return cached;
			}
		}

		function build(message: any, extra?: Record<string, any>) {
			const next = new Date();
			const diff = next.getTime() - last;
			last = next.getTime();

			// Merge closure tags with call extra
			const metadata = { ...tags, ...extra };

			// Format errors in metadata
			for (const key of Object.keys(metadata)) {
				const val = metadata[key];
				if (val instanceof Error) {
					metadata[key] = formatError(val);
				}
			}

			let metaString = "";
			if (Object.keys(metadata).length > 0) {
				try {
					metaString = stringifyExtra(metadata);
				} catch {
					// Fallback for safety
					metaString = JSON.stringify(metadata);
				}
			}

			const timestamp = next.toISOString().split(".")[0] ?? "";
			const msgStr = message instanceof Error ? formatError(message) : String(message);
			return `${timestamp} +${diff}ms ${metaString} ${msgStr}\n`;
		}

		const logger: Logger = {
			debug(message?: any, extra?: Record<string, any>) {
				if (shouldLog("DEBUG")) {
					write(`DEBUG ${build(message, extra)}`);
				}
			},
			info(message?: any, extra?: Record<string, any>) {
				if (shouldLog("INFO")) {
					write(`INFO  ${build(message, extra)}`);
				}
			},
			error(message?: any, extra?: Record<string, any>) {
				if (shouldLog("ERROR")) {
					write(`ERROR ${build(message, extra)}`);
				}
			},
			warn(message?: any, extra?: Record<string, any>) {
				if (shouldLog("WARN")) {
					write(`WARN  ${build(message, extra)}`);
				}
			},
			tag(key: string, value: string) {
				tags[key] = value;
				return logger;
			},
			clone() {
				return Log.create({ ...tags });
			},
			time(message: string, extra?: Record<string, any>) {
				const now = Date.now();
				logger.info(message, { status: "started", ...extra });
				function stop() {
					logger.info(message, {
						status: "completed",
						duration: Date.now() - now,
						...extra,
					});
				}
				return {
					stop,
					[Symbol.dispose]() {
						stop();
					},
				};
			},
		};

		if (service && typeof service === "string") {
			loggers.set(service, logger);
		}

		return logger;
	}

	export const Default = create({ service: "default" });
}
