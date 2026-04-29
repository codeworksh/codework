import { execFileSync } from "node:child_process";

const LOGIN_SHELL_ENV_NAMES = [
	"PATH",
	"SSH_AUTH_SOCK",
	"HOMEBREW_PREFIX",
	"HOMEBREW_CELLAR",
	"HOMEBREW_REPOSITORY",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

function logShellEnvironmentWarning(message: string, error?: unknown): void {
	console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

function parseEnvironmentDocument(raw: string): Partial<Record<(typeof LOGIN_SHELL_ENV_NAMES)[number], string>> {
	const parsed: Partial<Record<(typeof LOGIN_SHELL_ENV_NAMES)[number], string>> = {};

	for (const line of raw.split("\n")) {
		const separatorIndex = line.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const name = line.slice(0, separatorIndex);
		const value = line.slice(separatorIndex + 1);
		if (LOGIN_SHELL_ENV_NAMES.includes(name as (typeof LOGIN_SHELL_ENV_NAMES)[number])) {
			parsed[name as (typeof LOGIN_SHELL_ENV_NAMES)[number]] = value;
		}
	}

	return parsed;
}

function readEnvironmentFromLoginShell(
	shellPath: string,
): Partial<Record<(typeof LOGIN_SHELL_ENV_NAMES)[number], string>> {
	const script = `env | egrep '^(${LOGIN_SHELL_ENV_NAMES.join("|")})='`;
	const raw = execFileSync(shellPath, ["-lc", script], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return parseEnvironmentDocument(raw);
}

export function syncShellEnvironment(env: NodeJS.ProcessEnv = process.env): void {
	const platform = process.platform;
	if (platform !== "darwin" && platform !== "linux") {
		return;
	}

	const shellPath = env.SHELL?.trim();
	if (!shellPath) {
		return;
	}

	try {
		const shellEnvironment = readEnvironmentFromLoginShell(shellPath);

		for (const name of LOGIN_SHELL_ENV_NAMES) {
			const value = shellEnvironment[name];
			if (!value) {
				continue;
			}

			if (name === "PATH" || !env[name]) {
				env[name] = value;
			}
		}
	} catch (error) {
		logShellEnvironmentWarning("Failed to synchronize the desktop shell environment.", error);
	}
}
