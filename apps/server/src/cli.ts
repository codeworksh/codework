import { Config, Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
/* @effect-diagnostics nodeBuiltinImport:off -- the install folder sits under the OS home directory. */
import os from "node:os";
import path from "node:path";
import { Codework } from "./codework.ts";
import {
	type CliAction,
	type CliConfig,
	type CliEnvVar,
	CliError,
	type CliInstall,
	type CliServer,
} from "./contract.ts";
import { Kv } from "./kv.ts";

const executableKey = { package: "codework", key: "servers.local.executable" } as const;
const envKey = { package: "codework", key: "servers.local.env" } as const;
const argsKey = { package: "codework", key: "servers.local.args" } as const;

const savedArgs = Effect.gen(function* () {
	const saved = yield* (yield* Kv.Service).get(argsKey.package, argsKey.key);
	return Option.getOrElse(
		Option.filter(saved, (value): value is string => typeof value === "string"),
		() => "",
	);
});

/** Splits typed arguments as a shell would for plain words and quotes: `--name "a b"` is two. */
const splitArgs = (input: string) =>
	[...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

// Stored with every value; only the app server reads the sensitive ones.
const StoredEnv = Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }));
type StoredEnv = typeof StoredEnv.Type;

const savedEnv = Effect.gen(function* () {
	const saved = yield* (yield* Kv.Service).get(envKey.package, envKey.key);
	return Option.getOrElse(Option.flatMap(saved, Schema.decodeUnknownOption(StoredEnv)), (): StoredEnv => []);
});

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables as chosen: names must be shell names, once each, and leave the home to its own
 * setting; a sensitive one sent without a value keeps the saved value.
 */
const nextEnv = (chosen: ReadonlyArray<CliEnvVar>, saved: StoredEnv) =>
	Effect.gen(function* () {
		const names = new Set<string>();
		const next: Array<StoredEnv[number]> = [];
		for (const { name: raw, sensitive, value } of chosen) {
			const name = raw.trim();
			if (!VARIABLE_NAME.test(name))
				return yield* new CliError({
					message: `${name || "A blank name"} is not a variable name: use letters, digits and _.`,
				});
			if (name === "CODEWORK_HOME_DIR")
				return yield* new CliError({ message: "Set CODEWORK_HOME_DIR with the home path above." });
			if (names.has(name)) return yield* new CliError({ message: `${name} is set twice.` });
			names.add(name);
			// Only a variable that stays sensitive keeps its saved value, so none is ever revealed by unmarking it.
			const kept = sensitive
				? saved.find((variable) => variable.name === name && variable.sensitive)?.value
				: undefined;
			next.push({ name, sensitive, value: value ?? kept ?? "" });
		}
		return next;
	});

// Where the install script puts the binary unless told otherwise.
const installDir = Config.String("CODEWORK_INSTALL_DIR").pipe(
	Config.withDefault(path.join(os.homedir(), ".codework", "bin")),
	Effect.orDie,
);

/**
 * Runs `file` to completion, with stdout and stderr together; a spawn failure or timeout is a failure.
 * `env` is added to this process's own.
 */
const run = (
	file: string,
	args: ReadonlyArray<string>,
	timeout: `${number} seconds`,
	env: Record<string, string> = {},
) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(ChildProcess.make(file, args, { stdin: "ignore", env, extendEnv: true }));
		const [output, code] = yield* Effect.all(
			[handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
			{
				concurrency: "unbounded",
			},
		);
		return { output: output.trim(), code: Number(code) };
	}).pipe(Effect.scoped, Effect.timeout(timeout));

// A Node crash prints the source line first; the error line says what went wrong.
const reason = (output: string, code: number) => {
	const lines = output.split("\n").map((line) => line.trim());
	const line = lines.findLast((candidate) => /error/i.test(candidate)) ?? lines.findLast(Boolean);
	return line === undefined ? `exited with code ${code}` : `exited with code ${code}: ${line.slice(0, 240)}`;
};

// An app opened from the Dock does not inherit the terminal's PATH, so the login shell is asked.
const onPath = Effect.gen(function* () {
	const shell = process.env.SHELL ?? "/bin/sh";
	const { output } = yield* run(shell, ["-ilc", "command -v codework"], "5 seconds");
	return output
		.split("\n")
		.map((line) => line.trim())
		.findLast((line) => line.startsWith("/"));
}).pipe(Effect.orElseSucceed(() => undefined));

const probe = (file: string, custom: boolean) =>
	run(file, ["--version"], "10 seconds").pipe(
		Effect.map(({ output, code }): CliInstall => {
			const version = /\bv?(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
			if (code === 0 && version !== undefined) return { path: file, custom, version };
			return { path: file, custom, failure: reason(output, code) };
		}),
		Effect.catch((error) => Effect.succeed<CliInstall>({ path: file, custom, failure: error.message })),
	);

const chosenExecutable = Effect.gen(function* () {
	const saved = yield* (yield* Kv.Service).get(executableKey.package, executableKey.key);
	return Option.getOrUndefined(Option.filter(saved, (value): value is string => typeof value === "string"));
});

/**
 * The `codework` the app uses: the one chosen in Settings; else the install script's, else the login
 * shell's, whichever runs first; when neither runs, the first found, with why.
 */
const executable = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
	const chosen = yield* chosenExecutable;
	if (chosen !== undefined)
		return (yield* exists(chosen))
			? yield* probe(chosen, true)
			: ({ path: chosen, custom: true, failure: "No file at this path." } satisfies CliInstall);
	const candidates = [
		path.join(yield* installDir, "codework"),
		...Option.toArray(Option.fromUndefinedOr(yield* onPath)),
	];
	let broken: CliInstall | null = null;
	for (const file of candidates) {
		if (!(yield* exists(file))) continue;
		const found = yield* probe(file, false);
		if ("version" in found) return found;
		broken ??= found;
	}
	return broken;
});

/** A path typed in Settings: `~` is the user's home; blank means none; anything else must be absolute. */
const chosenPath = (input: string | null) =>
	Effect.gen(function* () {
		const trimmed = input?.trim() ?? "";
		if (trimmed === "") return null;
		const expanded =
			trimmed === "~" || trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
		if (!path.isAbsolute(expanded))
			return yield* new CliError({ message: "Use a full path, such as ~/.codework or /usr/local/bin/codework." });
		return path.normalize(expanded);
	});

const alive = (pid: number) =>
	Effect.sync(() => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			// EPERM: it exists, under another user.
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	});

/**
 * The registered server, asked through the app's own connection to it. A build whose replies differ
 * still answers `server.info`, so a call the app depends on decides whether it works with this app.
 */
const server = Effect.gen(function* () {
	const registered = yield* Codework.registration;
	if (Option.isNone(registered) || !(yield* alive(registered.value.pid))) return { _tag: "Stopped" } as const;
	const { url, pid } = registered.value;
	const info = yield* Codework.call((client) => client("server.info", {})).pipe(Effect.option);
	if (Option.isNone(info) || info.value.pid !== pid) return { _tag: "Unreachable", url, pid } satisfies CliServer;
	const { version } = info.value;
	const usable = yield* Codework.call((client) => client("session.list", {})).pipe(Effect.isSuccess);
	return { _tag: usable ? "Running" : "Incompatible", url, pid, version } satisfies CliServer;
});

// The app's connection reconnects with a backoff; waiting until it reaches the server keeps the
// status read right after from calling a healthy server unreachable.
const awaitConnection = Codework.call((client) => client("server.info", {})).pipe(
	Effect.retry(Schedule.spaced("250 millis")),
	Effect.timeout("15 seconds"),
	Effect.ignore,
);

export const handlers = {
	"cli.status": Effect.fn("cli.status")(function* () {
		const [cli, registered] = yield* Effect.all([executable, server], { concurrency: "unbounded" });
		const env = (yield* savedEnv).map(({ name, sensitive, value }) =>
			sensitive ? { name, sensitive } : { name, sensitive, value },
		);
		return { home: yield* (yield* Codework.Home).get, cli, server: registered, args: yield* savedArgs, env };
	}),

	"cli.configure": Effect.fn("cli.configure")(function* (config: typeof CliConfig.Type) {
		if (config.executable !== undefined) {
			const chosen = yield* chosenPath(config.executable);
			yield* (yield* Kv.Service).set(executableKey.package, executableKey.key, chosen);
		}
		if (config.args !== undefined) yield* (yield* Kv.Service).set(argsKey.package, argsKey.key, config.args.trim());
		if (config.env !== undefined) {
			const next = yield* nextEnv(config.env, yield* savedEnv);
			yield* (yield* Kv.Service).set(envKey.package, envKey.key, next);
		}
		if (config.home !== undefined) {
			yield* (yield* Codework.Home).set(yield* chosenPath(config.home));
			if (Option.isSome(yield* Codework.registration)) yield* awaitConnection;
		}
	}),

	// The CLI owns the server's lifecycle; the app only asks it, with the variables chosen and in the
	// home the app uses, which a variable never overrides.
	"cli.service": Effect.fn("cli.service")(function* ({ action }: { readonly action: CliAction }) {
		const cli = yield* executable;
		if (cli === null || !("version" in cli))
			return yield* new CliError({ message: "No working codework CLI was found." });
		const home = (yield* (yield* Codework.Home).get).path;
		const env = Object.fromEntries((yield* savedEnv).map(({ name, value }) => [name, value]));
		// `stop` takes no server options, so the arguments go only to what starts a server.
		const args = action === "stop" ? [] : splitArgs(yield* savedArgs);
		const { output, code } = yield* run(cli.path, ["service", action, ...args], "30 seconds", {
			...env,
			CODEWORK_HOME_DIR: home,
		}).pipe(Effect.mapError((error) => new CliError({ message: `codework service ${action}: ${error.message}` })));
		if (code !== 0) return yield* new CliError({ message: `codework service ${action} ${reason(output, code)}` });
		if (action !== "stop") yield* awaitConnection;
	}),
};

export * as Cli from "./cli.ts";
