import Type from "typebox";
import { Log } from "../util/log";
import { Filesystem } from "@codeworksh/utils";
import { NamedError } from "@codeworksh/utils";
import { Process } from "../util/process";

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

	export type ExecOptions = Process.RunOptions;

	export type ShellResult = Process.Result;

	interface BashShellResult {
		stdout: string | Uint8Array;
		stderr: string | Uint8Array;
		exitCode: number;
	}

	export interface BashLike {
		exec(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv | null }): Promise<BashShellResult>;

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

		exec(command: string, options?: ExecOptions): Promise<ShellResult>;
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

		exec(command: string, options?: ExecOptions): Promise<ShellResult>;

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
		createSandboxEnv(options: { id: string; cwd: string }): Promise<Env>;
	}

	export type SessionEnv = Env;

	/** Wrap a Sandbox API into an Env without an intermediate shell filesystem layer. */
	export function createSandboxSessionEnv(api: API, cwd: string, cleanup?: () => Promise<void>): SessionEnv {
		if (!cwd) {
			throw new SandboxError({ message: "cwd is required to create a sandbox session env." });
		}

		const normalizedCwd = normalizeSandboxPath(cwd);
		const resolvePath = (p: string): string => {
			if (!p) return normalizedCwd;
			if (p.startsWith("/")) return normalizeSandboxPath(p);
			if (normalizedCwd === "/") return normalizeSandboxPath(`/${p}`);
			return normalizeSandboxPath(`${normalizedCwd}/${p}`);
		};

		return {
			id: normalizedCwd,
			exec: (command, options) =>
				api.exec(command, {
					...options,
					cwd: options?.cwd ? resolvePath(options.cwd) : normalizedCwd,
				}),
			readFile: (p) => api.readFile(resolvePath(p)),
			readFileBuffer: (p) => api.readFileBuffer(resolvePath(p)),
			writeFile: (p, content) => api.writeFile(resolvePath(p), content),
			stat: (p) => api.stat(resolvePath(p)),
			readdir: (p) => api.readdir(resolvePath(p)),
			exists: (p) => api.exists(resolvePath(p)),
			mkdir: (p, options) => api.mkdir(resolvePath(p), options),
			rm: (p, options) => api.rm(resolvePath(p), options),
			cwd: normalizedCwd,
			resolvePath,
			cleanup: async () => {
				await cleanup?.();
			},
		};
	}

	export async function bashFactoryToSandboxEnv(
		id: IdGenerator,
		factory: BashFactory,
		ephemeral?: boolean,
	): Promise<Env> {
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

		// create  Bash Scoped Env
		async function createBashScopedEnv(commands: Command[]): Promise<Env> {
			const scoped = await createBash();
			registerCommands(scoped, commands);
			return createBashSandboxEnv(id, scoped, createBashScopedEnv, ephemeral);
		}

		const base = await createBash();
		return createBashSandboxEnv(id, base, createBashScopedEnv, ephemeral);
	}

	// create Bash Sandbox Env
	async function createBashSandboxEnv(
		id: IdGenerator,
		bash: BashLike,
		createScope: (commands: Command[]) => Promise<Env>,
		ephemeral?: boolean,
	): Promise<Env> {
		const sandboxId = await id();
		const fs = bash.fs;
		const cwd = bash.getCwd();
		const resolve = (p: string) => (p.startsWith("/") ? p : fs.resolvePath(cwd, p));

		return {
			id: sandboxId,
			ephemeral,
			exec: async (cmd, opts) => {
				const executable = bash as BashLike & {
					exec(
						command: string,
						options?: { cwd?: string; env?: NodeJS.ProcessEnv | null; signal?: AbortSignal },
					): Promise<BashShellResult>;
				};
				const timeout = opts?.timeout;
				let timeoutSignal: AbortSignal | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let abortListener: (() => void) | undefined;

				if (typeof timeout === "number" || opts?.abort) {
					const controller = new AbortController();
					timeoutSignal = controller.signal;
					if (typeof timeout === "number") {
						timer = setTimeout(() => controller.abort(), timeout);
					}
					if (opts?.abort) {
						abortListener = () => controller.abort();
						opts.abort.addEventListener("abort", abortListener, { once: true });
						if (opts.abort.aborted) controller.abort();
					}
				}

				try {
					const result = await executable.exec(
						cmd,
						opts ? { cwd: opts.cwd, env: opts.env, signal: timeoutSignal } : undefined,
					);
					if (timeoutSignal?.aborted) {
						const converted = toShellResult(result);
						return {
							...converted,
							stderr:
								converted.stderr.length > 0
									? converted.stderr
									: Buffer.from(
											typeof timeout === "number"
												? `[codework] Command timed out after ${timeout}ms.`
												: "[codework] Command aborted.",
										),
						};
					}
					return toShellResult(result);
				} finally {
					if (timer) clearTimeout(timer);
					if (abortListener) opts?.abort?.removeEventListener("abort", abortListener);
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

	function normalizeSandboxPath(p: string): string {
		const absolute = p.startsWith("/");
		const parts: string[] = [];
		for (const part of p.split("/")) {
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (parts.length > 0 && parts[parts.length - 1] !== "..") {
					parts.pop();
				} else if (!absolute) {
					parts.push(part);
				}
				continue;
			}
			parts.push(part);
		}

		const normalized = parts.join("/");
		if (absolute) return `/${normalized}`;
		return normalized || ".";
	}

	function toShellResult(result: BashShellResult): ShellResult {
		return {
			code: result.exitCode,
			stdout: Buffer.from(result.stdout),
			stderr: Buffer.from(result.stderr),
		};
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
