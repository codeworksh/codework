import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Reads current git branch from .git/HEAD by walking up directory tree.
 * Pure filesystem check, zero subprocess overhead.
 */
export function getGitBranch(startDir: string = process.cwd()): string | null {
	let current = path.resolve(startDir);
	const root = path.parse(current).root;

	while (current !== root) {
		const gitDir = path.join(current, ".git");
		if (existsSync(gitDir)) {
			try {
				const headPath = path.join(gitDir, "HEAD");
				if (existsSync(headPath)) {
					const head = readFileSync(headPath, "utf8").trim();
					if (head.startsWith("ref: refs/heads/")) {
						return head.replace("ref: refs/heads/", "").trim();
					}
					// Detached HEAD or hash
					return head.slice(0, 7);
				}
			} catch {
				return null;
			}
		}
		current = path.dirname(current);
	}

	return null;
}

/**
 * Replaces home directory with `~`.
 */
export function tildify(filePath: string): string {
	const home = os.homedir();
	const normalized = path.normalize(filePath);
	if (normalized === home) {
		return "~";
	}
	if (normalized.startsWith(`${home}${path.sep}`)) {
		return `~${normalized.slice(home.length)}`;
	}
	return normalized;
}

/**
 * Returns formatted location string e.g. `~/project:branch`.
 */
export function getFormattedLocation(cwd: string = process.cwd()): string {
	const displayPath = tildify(cwd);
	const branch = getGitBranch(cwd);
	return branch ? `${displayPath}:${branch}` : displayPath;
}

/**
 * Truncates string with ellipsis in the front or middle to fit within maxWidth.
 */
export function truncateLocation(loc: string, maxWidth: number): string {
	if (loc.length <= maxWidth) return loc;
	const prefix = "...";
	const keepLen = maxWidth - prefix.length;
	if (keepLen <= 0) return loc.slice(0, maxWidth);
	return `${prefix}${loc.slice(loc.length - keepLen)}`;
}
