import { Process } from "./process";
import { WorkspaceContext } from "../workspace/context";

const GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];

export function looksLikeGitUrl(source: string): boolean {
	const normalized = source.replace(/^https?:\/\//, "");
	return GIT_HOSTS.some((host) => normalized.startsWith(`${host}/`));
}

export interface GitResult {
	code: number;
	text(): string;
	stdout: Buffer;
	stderr: Buffer;
}

function activeSandbox() {
	try {
		return WorkspaceContext.sandbox;
	} catch {
		return undefined;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run a git command.
 *
 * Uses the active workspace sandbox when available, with Process as a fallback for utility callers.
 */
export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<GitResult> {
	const sandbox = activeSandbox();
	try {
		const result = sandbox
			? await sandbox.exec(["git", ...args].map(shellQuote).join(" "), {
					cwd: opts.cwd,
					env: opts.env,
					stdin: "ignore",
					nothrow: true,
				})
			: await Process.run(["git", ...args], {
					cwd: opts.cwd,
					env: opts.env,
					stdin: "ignore",
					nothrow: true,
				});

		return {
			code: result.code,
			text: () => result.stdout.toString(),
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} catch (error) {
		return {
			code: 1,
			text: () => "",
			stdout: Buffer.alloc(0),
			stderr: Buffer.from(error instanceof Error ? error.message : String(error)),
		};
	}
}
