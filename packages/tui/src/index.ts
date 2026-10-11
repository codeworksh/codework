/* @effect-diagnostics nodeBuiltinImport:off -- the launcher owns the child process and its terminal. */
import { spawn } from "node:child_process";
import { resolveBinary } from "./binary.ts";

export { LauncherError, platform, resolveBinary, type Platform } from "./binary.ts";

/** The environment variable the Rust TUI reads for the server endpoint. */
export const ENV_SERVER = "CODEWORK_RPC_SERVER";

export interface LaunchOptions {
	/** Arguments forwarded verbatim to the TUI, after the binary. */
	readonly args?: ReadonlyArray<string>;
	/** The server endpoint. Exported as {@link ENV_SERVER} for the child. */
	readonly server?: string;
	/** Overrides the resolved binary; mainly for tests. */
	readonly binary?: string;
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run the CodeWork TUI as a foreground child of this process.
 *
 * Terminal I/O is inherited rather than piped: the TUI owns the alternate
 * screen, reads raw keystrokes and draws directly, so any buffering here would
 * corrupt it. Signals the terminal sends to the foreground process group reach
 * the child on their own; the ones a caller sends to this process explicitly are
 * forwarded, so `kill` on the CLI does not orphan the UI. The resolved exit code
 * becomes the caller's.
 */
export function launch(options: LaunchOptions = {}): Promise<number> {
	const binary = options.binary ?? resolveBinary(options.env ?? process.env);
	const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
	if (options.server !== undefined) env[ENV_SERVER] = options.server;

	const child = spawn(binary, [...(options.args ?? [])], {
		stdio: "inherit",
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		env,
	});

	const forwarded: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
	const relay = (signal: NodeJS.Signals) => () => {
		if (child.exitCode === null && child.signalCode === null) child.kill(signal);
	};
	const handlers = forwarded.map((signal) => {
		const handler = relay(signal);
		process.on(signal, handler);
		return [signal, handler] as const;
	});

	return new Promise<number>((resolve, reject) => {
		child.once("error", (cause) => {
			cleanup();
			reject(cause);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			// A child killed by a signal has no code; mirror the shell's 128 + signal
			// convention so a caller sees a non-zero status rather than a false success.
			resolve(code ?? (signal === null ? 0 : 128 + signalNumber(signal)));
		});
	});

	function cleanup() {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	}
}

const signalNumbers: Readonly<Record<string, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGTERM: 15,
};

const signalNumber = (signal: string): number => signalNumbers[signal] ?? 1;
