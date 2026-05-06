import { Bash, InMemoryFs, ReadWriteFs, MountableFs } from "just-bash";
import { Sandbox } from "./sandbox";
import { randomUUID } from "node:crypto";
import nodeFs from "node:fs/promises";
import path from "node:path";
import { Process } from "../util/process.ts";

/**
 * Create an empty in-memory sandbox (default).
 * Uses InMemoryFs (no real filesystem access) with sensible defaults:
 * cwd = /home/user, /tmp exists, /bin and /usr/bin exist.
 */
export async function createInMemoryEphemeralEnv() {
	const fs = new InMemoryFs();
	return Sandbox.bashFactoryToSandboxEnv(
		() => randomUUID(),
		() =>
			new Bash({
				fs,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
		true,
	);
}

/**
 * Create a local sandbox backed by the host filesystem.
 * Mounts directory at `directory` workspace via ReadWriteFs + MountableFs.
 */
export async function createLocalEnv(directory: string) {
	const rwfs = new ReadWriteFs({ root: directory });
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount(directory, rwfs);
	return Sandbox.bashFactoryToSandboxEnv(
		() => directory,
		() =>
			new Bash({
				fs,
				cwd: directory,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
	);
}

export class LocalNodeEnv implements Sandbox.API {
	private readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	private toHostPath(sandboxPath: string): string {
		const hostPath = path.isAbsolute(sandboxPath) ? path.resolve(sandboxPath) : path.resolve(this.root, sandboxPath);
		const relative = path.relative(this.root, hostPath);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return hostPath;
		throw new Error(`Path escapes sandbox root: ${sandboxPath}`);
	}

	async readFile(filePath: string): Promise<string> {
		return await nodeFs.readFile(this.toHostPath(filePath), "utf8");
	}

	async readFileBuffer(filePath: string): Promise<Uint8Array> {
		return await nodeFs.readFile(this.toHostPath(filePath));
	}

	async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
		const hostPath = this.toHostPath(filePath);
		await nodeFs.mkdir(path.dirname(hostPath), { recursive: true });
		await nodeFs.writeFile(hostPath, content);
	}

	async stat(filePath: string) {
		const info = await nodeFs.lstat(this.toHostPath(filePath));
		return {
			isFile: info.isFile(),
			isDirectory: info.isDirectory(),
			isSymbolicLink: info.isSymbolicLink(),
			size: info.size,
			mtime: info.mtime,
		};
	}

	async readdir(dirPath: string): Promise<string[]> {
		return await nodeFs.readdir(this.toHostPath(dirPath));
	}

	async exists(filePath: string): Promise<boolean> {
		try {
			await nodeFs.access(this.toHostPath(filePath));
			return true;
		} catch {
			return false;
		}
	}

	async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
		await nodeFs.mkdir(this.toHostPath(dirPath), { recursive: options?.recursive });
	}

	async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await nodeFs.rm(this.toHostPath(filePath), {
			force: options?.force,
			recursive: options?.recursive,
		});
	}

	async exec(command: string, options?: Sandbox.ExecOptions): Promise<Sandbox.ShellResult> {
		const cwd = this.toHostPath(options?.cwd ?? this.root);
		return await Process.run(["bash", "-lc", command], {
			...options,
			cwd,
			nothrow: options?.nothrow ?? true,
		});
	}
}

export async function createLocalNodeEnv(directory: string): Promise<Sandbox.Env> {
	const cwd = path.resolve(directory);
	await nodeFs.mkdir(cwd, { recursive: true });
	const api = new LocalNodeEnv(cwd);
	const env = Sandbox.createSandboxSessionEnv(api, cwd);

	return {
		...env,
		scope: async (options) => {
			if (options?.commands?.length) {
				throw new Error("LocalNodeEnv does not support scoped custom commands.");
			}
			return await createLocalNodeEnv(cwd);
		},
	};
}

export function createLocalNodeFactory(): Sandbox.Factory {
	return {
		async createSandboxEnv(options) {
			return await createLocalNodeEnv(options.cwd);
		},
	};
}
