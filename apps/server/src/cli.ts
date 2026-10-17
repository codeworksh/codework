import { Config, Effect, FileSystem, Option, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
/* @effect-diagnostics nodeBuiltinImport:off -- the install folder sits under the OS home directory. */
import os from "node:os";
import path from "node:path";
import { Codework } from "./codework.ts";
import {
	type CliAction,
	type CliInstall,
	type CliServer,
	type ServerAdd,
	ServersError,
	type ServerStatus,
	type ServerUpdate,
} from "./contract.ts";
import { Servers } from "./servers.ts";

/** Splits typed arguments as a shell would for plain words and quotes: `--name "a b"` is two. */
const splitArgs = (input: string) =>
	[...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

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

const exists = (file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
	});

/**
 * The `codework` found without a choice: the install script's, else the login shell's, whichever
 * runs first; when neither runs, the first found, with why.
 */
const found = Effect.gen(function* () {
	const candidates = [
		path.join(yield* installDir, "codework"),
		...Option.toArray(Option.fromUndefinedOr(yield* onPath)),
	];
	let broken: CliInstall | null = null;
	for (const file of candidates) {
		if (!(yield* exists(file))) continue;
		const install = yield* probe(file, false);
		if ("version" in install) return install;
		broken ??= install;
	}
	return broken;
});

/** The `codework` a server runs: the one chosen for it, else the one found. */
const executableOf = (row: Servers.Row, foundOnce: typeof found) =>
	row.executable === null
		? foundOnce
		: Effect.flatMap(exists(row.executable), (present) =>
				present
					? probe(row.executable!, true)
					: Effect.succeed<CliInstall>({ path: row.executable!, custom: true, failure: "No file at this path." }),
			);

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
 * The server a home names. The default one is asked through the app's own connection, since a build
 * whose replies differ still answers `server.info`: a call the app depends on decides whether it
 * works with this app. Any other is taken from its registration and process.
 */
const serverAt = (home: string, isDefault: boolean) =>
	Effect.gen(function* () {
		const registered = yield* Codework.registrationAt(home);
		if (Option.isNone(registered) || !(yield* alive(registered.value.pid))) return { _tag: "Stopped" } as const;
		const { url, pid, version: registeredVersion } = registered.value;
		if (!isDefault) return { _tag: "Running", url, pid, version: registeredVersion } satisfies CliServer;
		const info = yield* Codework.call((client) => client("server.info", {})).pipe(Effect.option);
		if (Option.isNone(info) || info.value.pid !== pid) return { _tag: "Unreachable", url, pid } satisfies CliServer;
		const { version } = info.value;
		const usable = yield* Codework.call((client) => client("session.list", {})).pipe(Effect.isSuccess);
		return { _tag: usable ? "Running" : "Incompatible", url, pid, version } satisfies CliServer;
	});

// The app's connection reconnects with a backoff; waiting until it reaches the server keeps the
// status read right after from calling a healthy server unreachable. Only when there is one to reach.
const awaitConnection = Effect.gen(function* () {
	if (Option.isNone(yield* Codework.registration)) return;
	yield* Codework.call((client) => client("server.info", {})).pipe(
		Effect.retry(Schedule.spaced("250 millis")),
		Effect.timeout("15 seconds"),
		Effect.ignore,
	);
});

export const handlers = {
	"servers.list": Effect.fn("servers.list")(function* () {
		const servers = yield* Servers.Service;
		const foundOnce = yield* Effect.cached(found);
		return yield* Effect.forEach(
			yield* servers.list,
			(row) =>
				Effect.gen(function* () {
					const home = servers.homeOf(row);
					const [cli, server] = yield* Effect.all(
						[executableOf(row, foundOnce), serverAt(home.path, row.isDefault)],
						{
							concurrency: "unbounded",
						},
					);
					return {
						id: row.id,
						kind: row.kind,
						name: row.name,
						isDefault: row.isDefault,
						home,
						cli,
						server,
						args: row.args,
						env: row.env.map(({ name, sensitive, value }) =>
							sensitive ? { name, sensitive } : { name, sensitive, value },
						),
					} satisfies ServerStatus;
				}),
			{ concurrency: "unbounded" },
		);
	}),

	"servers.add": Effect.fn("servers.add")(function* (input: ServerAdd) {
		return yield* (yield* Servers.Service).add(input);
	}),

	"servers.update": Effect.fn("servers.update")(function* (input: ServerUpdate) {
		const servers = yield* Servers.Service;
		const before = yield* servers.defaultHome;
		yield* servers.update(input);
		if ((yield* servers.defaultHome) !== before) yield* awaitConnection;
	}),

	"servers.remove": Effect.fn("servers.remove")(function* ({ id }: { readonly id: string }) {
		yield* (yield* Servers.Service).remove(id);
	}),

	"servers.setDefault": Effect.fn("servers.setDefault")(function* ({ id }: { readonly id: string }) {
		const servers = yield* Servers.Service;
		const before = yield* servers.defaultHome;
		yield* servers.setDefault(id);
		if ((yield* servers.defaultHome) !== before) yield* awaitConnection;
	}),

	// The CLI owns a server's lifecycle; the app only asks it, with the server's variables and in its
	// home, which a variable never overrides.
	"servers.service": Effect.fn("servers.service")(function* ({
		id,
		action,
	}: {
		readonly id: string;
		readonly action: CliAction;
	}) {
		const servers = yield* Servers.Service;
		const row = yield* servers.get(id);
		const cli = yield* executableOf(row, found);
		if (cli === null || !("version" in cli))
			return yield* new ServersError({ message: "No working codework CLI was found." });
		const env = Object.fromEntries(row.env.map(({ name, value }) => [name, value]));
		// `stop` takes no server options, so the arguments go only to what starts a server.
		const args = action === "stop" ? [] : splitArgs(row.args);
		const { output, code } = yield* run(cli.path, ["service", action, ...args], "30 seconds", {
			...env,
			CODEWORK_HOME_DIR: servers.homeOf(row).path,
		}).pipe(
			Effect.mapError((error) => new ServersError({ message: `codework service ${action}: ${error.message}` })),
		);
		if (code !== 0) return yield* new ServersError({ message: `codework service ${action} ${reason(output, code)}` });
		if (row.isDefault && action !== "stop") yield* awaitConnection;
	}),
};

export * as Cli from "./cli.ts";
