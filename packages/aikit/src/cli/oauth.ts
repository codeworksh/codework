import type { CommandModule } from "yargs";
import {
	GitHubCopilotOAuthClient,
	type GitHubCopilotOAuthCredentials,
	JsonGitHubCopilotAuthStorage,
} from "../oauth/github/copilot.ts";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	type OpenAICodexOAuthCredentials,
} from "../oauth/openai/codex.ts";
import { openBrowser, promptLine } from "../oauth/interactive.ts";
import {
	checkOAuthProvider,
	formatOAuthSummary,
	oauthLoginIssue,
	oauthRefreshIssue,
	oauthNotice,
	summarizeGitHubCopilot,
	summarizeOpenAICodex,
} from "../oauth/summary.ts";

// `?: T | undefined` rather than plain `?: T`: yargs hands these through as explicit `undefined`,
// which a bare optional property no longer accepts under `exactOptionalPropertyTypes`.
type AuthArgs = {
	openaiCodex?: boolean | undefined;
	githubCopilot?: boolean | undefined;
	authFile?: string | undefined;
	browser?: boolean | undefined;
	device?: boolean | undefined;
	status?: boolean | undefined;
	refresh?: boolean | undefined;
	logout?: boolean | undefined;
	json?: boolean | undefined;
	enterprise?: string | undefined;
	enableModels?: boolean | undefined;
};

async function runOpenAICodexAuth(args: AuthArgs): Promise<void> {
	const storage = new JsonOpenAICodexAuthStorage({
		...(args.authFile !== undefined && { path: args.authFile }),
	});
	const client = new OpenAICodexOAuthClient({ storage });

	const show = (credentials: OpenAICodexOAuthCredentials) =>
		process.stdout.write(formatOAuthSummary(summarizeOpenAICodex(credentials), { json: args.json === true }));

	if (args.logout) {
		await client.logout();
		console.warn(oauthNotice("cleared", "openai-codex", storage.path));
		return;
	}

	if (args.status || args.refresh) {
		// --status is a read: asking the client for headers would refresh behind it.
		const credentials = args.refresh ? await client.getCredentials() : await storage.get();
		if (!credentials) {
			console.error(oauthNotice("missing", "openai-codex", storage.path));
			process.exitCode = 1;
			return;
		}
		if (args.refresh) console.warn(oauthNotice("refreshed", "openai-codex", storage.path));
		show(credentials);
		return;
	}

	const credentials = await client.login({
		device: args.device === true,
		// stderr, so `--json` stdout stays parseable.
		onAuth: (info) => {
			console.warn(info.instructions ?? "Complete OpenAI Codex authentication in your browser.");
			if (info.userCode) console.warn(`Enter code: ${info.userCode}`);
			console.warn(info.url);
			if (args.browser !== false) {
				void openBrowser(info.url, (error) => console.warn(`Failed to open browser: ${error.message}`));
			}
		},
		onProgress: (message) => console.warn(message),
		onPrompt: async (prompt) => promptLine(prompt.message),
	});

	console.warn(oauthNotice("saved", "openai-codex", storage.path));
	show(credentials);
}

async function runGitHubCopilotAuth(args: AuthArgs): Promise<void> {
	const storage = new JsonGitHubCopilotAuthStorage({
		...(args.authFile !== undefined && { path: args.authFile }),
	});
	const client = new GitHubCopilotOAuthClient({ storage });

	const show = (credentials: GitHubCopilotOAuthCredentials) =>
		process.stdout.write(formatOAuthSummary(summarizeGitHubCopilot(credentials), { json: args.json === true }));

	if (args.logout) {
		await client.logout();
		console.warn(oauthNotice("cleared", "github-copilot", storage.path));
		return;
	}

	if (args.status) {
		const credentials = await storage.get();
		if (!credentials) {
			console.error(oauthNotice("missing", "github-copilot", storage.path));
			process.exitCode = 1;
			return;
		}
		show(credentials);
		return;
	}

	// GitHub OAuth tokens never expire; there is no refresh path.
	const credentials = await client.login({
		...(args.enterprise !== undefined && { enterpriseUrl: args.enterprise }),
		enableModels: args.enableModels === true,
		// stderr, so `--json` stdout stays parseable.
		onAuth: (info) => {
			console.warn(info.instructions ?? "Complete GitHub Copilot authentication in your browser.");
			console.warn(`Enter code: ${info.userCode}`);
			console.warn(info.url);
			if (args.browser !== false) {
				void openBrowser(info.url, (error) => console.warn(`Failed to open browser: ${error.message}`));
			}
		},
		onProgress: (message) => console.warn(message),
	});

	console.warn(oauthNotice("saved", "github-copilot", storage.path));
	show(credentials);
}

export const OAuthCommand: CommandModule<object, AuthArgs> = {
	command: "auth",
	describe: "manage OAuth credentials",
	builder: (yargs) =>
		yargs
			.option("openai-codex", {
				type: "boolean",
				describe: "use OpenAI Codex OAuth",
			})
			.option("github-copilot", {
				type: "boolean",
				describe: "use GitHub Copilot OAuth (device flow)",
			})
			.option("enterprise", {
				type: "string",
				describe: "GitHub Enterprise domain for GitHub Copilot login",
			})
			.option("enable-models", {
				type: "boolean",
				describe: "enable unconfigured Copilot catalog models after login",
			})
			.option("auth-file", {
				type: "string",
				describe: "path to auth.json (defaults to CODEWORK_CREDENTIALS or ~/.codework/aikit/auth.json)",
			})
			.option("browser", {
				type: "boolean",
				default: true,
				describe: "open the authorization URL in the default browser",
			})
			.option("device", {
				type: "boolean",
				default: false,
				describe: "use the device-code flow instead of a localhost browser callback",
			})
			.option("status", {
				type: "boolean",
				describe: "show stored credential status without refreshing",
			})
			.option("refresh", {
				type: "boolean",
				describe: "refresh stored credentials if expired",
			})
			.option("logout", {
				type: "boolean",
				describe: "clear stored credentials",
			})
			.option("json", {
				type: "boolean",
				describe: "print machine-readable output",
			})
			// yargs types this callback with the kebab-case keys, so read those.
			.check((args) => {
				const checked = checkOAuthProvider({
					openaiCodex: args["openai-codex"],
					githubCopilot: args["github-copilot"],
				});
				if (!checked.ok) throw new Error(checked.message);
				if ([args.status, args.refresh, args.logout].filter(Boolean).length > 1) {
					throw new Error("choose only one of --status, --refresh, or --logout");
				}
				const issue =
					oauthLoginIssue(checked.provider, {
						device: args.device,
						enterprise: args.enterprise,
						enableModels: args["enable-models"],
					}) ?? (args.refresh ? oauthRefreshIssue(checked.provider) : undefined);
				if (issue) throw new Error(issue);
				return true;
			}),
	handler: async (args) => {
		if (args.githubCopilot) {
			await runGitHubCopilotAuth(args);
			return;
		}
		await runOpenAICodexAuth(args);
	},
};
