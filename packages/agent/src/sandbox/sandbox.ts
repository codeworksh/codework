import Type from "typebox";
import { Log } from "../util/log";
import { Filesystem } from "@codeworksh/utils";
import { NamedError } from "@codeworksh/utils";

export namespace Sandbox {
	const log = Log.create({ service: "sandbox" });

	const SandboxError = NamedError.create(
		"SandboxError",
		Type.Object({
			message: Type.String(),
		}),
	);

	export interface Command {
		name: string;

		execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	}

	export interface ShellResult {
		stdout: string;
		stderr: string;
		exitCode: number;
	}

	export interface BashLike {
		exec(command: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<ShellResult>;

		getCwd(): string;

		fs: {
			readFile(path: string, options?: any): Promise<string>;
			readFileBuffer(path: string): Promise<Uint8Array>;
			writeFile(path: string, content: string | Uint8Array, options?: any): Promise<void>;
			stat(path: string): Promise<any>;
			readdir(path: string): Promise<string[]>;
			exists(path: string): Promise<boolean>;
			mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
			rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
			resolvePath(base: string, path: string): string;
		};

		registerCommand?(cmd: any): void;
	}

	export type IdGenerator = () => string | Promise<string>;

	/** Factory for a fresh Bash-like runtime. Share `fs` inside the closure to persist files. */
	export type BashFactory = () => BashLike | Promise<BashLike>;

	/** Interface that remote sandbox providers must implement. */
	export interface API {
		readFile(path: string): Promise<string>;

		readFileBuffer(path: string): Promise<Uint8Array>;

		writeFile(path: string, content: string | Uint8Array): Promise<void>;

		stat(path: string): Promise<Filesystem.FileStat>;

		readdir(path: string): Promise<string[]>;

		exists(path: string): Promise<boolean>;

		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

		exec(
			command: string,
			options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
		): Promise<ShellResult>;
	}

	/**
	 * Universal sandbox environment interface. All sandbox modes (isolate, local, remote)
	 * implement this — no mode-specific branching needed in core logic.
	 *
	 * File methods accept both absolute and relative paths (resolved against `cwd`).
	 */
	export interface Env {
		id: string;
		ephemeral?: boolean;

		exec(
			command: string,
			options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
		): Promise<ShellResult>;

		/** Create an operation-scoped environment, usually backed by a fresh Bash runtime. */
		scope?(options?: { commands?: Command[] }): Promise<Env>;

		readFile(path: string): Promise<string>;

		readFileBuffer(path: string): Promise<Uint8Array>;

		writeFile(path: string, content: string | Uint8Array): Promise<void>;

		stat(path: string): Promise<Filesystem.FileStat>;

		readdir(path: string): Promise<string[]>;

		exists(path: string): Promise<boolean>;

		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

		cwd: string;

		/**
		 * Resolve a relative path against cwd. Absolute paths pass through.
		 * File methods resolve internally — only needed when you need the absolute path
		 * for your own logic (e.g., extracting the parent directory).
		 */
		resolvePath(p: string): string;

		cleanup(): Promise<void>;
	}

	export interface Factory {
		createSandboxEnv(options: { id: string; cwd?: string }): Promise<Env>;
	}

	export async function bashFactoryToSessionEnv(id: IdGenerator, factory: BashFactory): Promise<Env> {
		log.info("create bash sandbox env");
		const seen = new WeakSet<object>();

		async function createBash(): Promise<BashLike> {
			const bash = await factory();
			assertBashLike(bash);
			if (seen.has(bash)) {
				throw new SandboxError({
					message:
						"BashFactory must return a fresh Bash-like instance for each operation. " +
						"share the filesystem object in the factory closure to persist files across calls.",
				});
			}
			seen.add(bash);
			return bash;
		}

		async function createBashScopedEnv(commands: Command[]): Promise<Env> {
			const scoped = await createBash();
			registerCommands(scoped, commands);
			return createBashSessionEnv(id, scoped, createBashScopedEnv);
		}

		const base = await createBash();
		return createBashSessionEnv(id, base, createBashScopedEnv);
	}

	async function createBashSessionEnv(
		id: IdGenerator,
		bash: BashLike,
		createScope: (commands: Command[]) => Promise<Env>,
	): Promise<Env> {
		const sandboxId = await id();
		const fs = bash.fs;
		const cwd = bash.getCwd();
		const resolve = (p: string) => (p.startsWith("/") ? p : fs.resolvePath(cwd, p));

		return {
			id: sandboxId,
			exec: async (cmd, opts) => {
				const executable = bash as BashLike & {
					exec(
						command: string,
						options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
					): Promise<ShellResult>;
				};
				const timeout = opts?.timeout;
				let timeoutSignal: AbortSignal | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;

				if (typeof timeout === "number") {
					const controller = new AbortController();
					timeoutSignal = controller.signal;
					timer = setTimeout(() => controller.abort(), timeout * 1000);
				}

				try {
					const result = await executable.exec(
						cmd,
						opts ? { cwd: opts.cwd, env: opts.env, signal: timeoutSignal } : undefined,
					);
					if (timeoutSignal?.aborted) {
						return {
							...result,
							stderr: result.stderr || `[flue] Command timed out after ${timeout} seconds.`,
						};
					}
					return result;
				} finally {
					if (timer) clearTimeout(timer);
				}
			},
			scope: (options) => createScope(options?.commands ?? []),
			readFile: (p) => fs.readFile(resolve(p)),
			readFileBuffer: (p) => fs.readFileBuffer(resolve(p)),
			writeFile: async (p, content) => {
				const resolved = resolve(p);
				const dir = resolved.replace(/\/[^/]*$/, "");
				if (dir && dir !== resolved) {
					try {
						await fs.mkdir(dir, { recursive: true });
					} catch {
						/* parent already exists */
					}
				}
				await fs.writeFile(resolved, content);
			},
			stat: (p) => fs.stat(resolve(p)),
			readdir: (p) => fs.readdir(resolve(p)),
			exists: (p) => fs.exists(resolve(p)),
			mkdir: (p, o) => fs.mkdir(resolve(p), o),
			rm: (p, o) => fs.rm(resolve(p), o),
			cwd,
			resolvePath: resolve,
			cleanup: async () => {},
		};
	}

	function registerCommands(bash: BashLike, commands: Command[]): void {
		if (commands.length === 0) return;
		if (typeof bash.registerCommand !== "function") {
			throw new SandboxError({
				message: "cannot use commands: this Bash-like sandbox does not support command registration.",
			});
		}
		for (const cmd of commands) {
			bash.registerCommand({ name: cmd.name, execute: (args: string[]) => cmd.execute(args) });
		}
	}

	function assertBashLike(value: unknown): asserts value is BashLike {
		if (
			typeof value !== "object" ||
			value === null ||
			!("exec" in value) ||
			!("getCwd" in value) ||
			!("fs" in value) ||
			typeof (value as any).exec !== "function" ||
			typeof (value as any).getCwd !== "function" ||
			typeof (value as any).fs !== "object"
		) {
			throw new Error("BashFactory must return a Bash-like object.");
		}
	}
}
