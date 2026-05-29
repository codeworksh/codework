import type { CommandModule } from "yargs";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	type OpenAICodexOAuthCredentials,
	openAICodexHeaders,
} from "../oauth/openai/codex";

type AuthArgs = {
	openaiCodex?: boolean;
	authFile?: string;
	browser?: boolean;
	manual?: boolean;
	status?: boolean;
	refresh?: boolean;
	logout?: boolean;
	json?: boolean;
	printHeaders?: boolean;
	originator?: string;
};

async function promptLine(message: string): Promise<string> {
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		return await rl.question(`${message} `);
	} finally {
		rl.close();
	}
}

async function openBrowser(url: string): Promise<void> {
	const { spawn } = await import("node:child_process");
	const command =
		process.platform === "darwin"
			? { file: "open", args: [url] }
			: process.platform === "win32"
				? { file: "cmd", args: ["/c", "start", "", url] }
				: { file: "xdg-open", args: [url] };

	const child = spawn(command.file, command.args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

function printCredentials(
	credentials: OpenAICodexOAuthCredentials,
	options: { json?: boolean; printHeaders?: boolean },
) {
	if (options.json) {
		console.log(
			JSON.stringify(
				{
					accountId: credentials.accountId,
					expires: credentials.expires,
					expiresAt: new Date(credentials.expires).toISOString(),
					headers: options.printHeaders ? openAICodexHeaders(credentials) : undefined,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Account: ${credentials.accountId}`);
	console.log(`Expires: ${new Date(credentials.expires).toLocaleString()}`);
	if (options.printHeaders) {
		console.log("Headers:");
		for (const [name, value] of Object.entries(openAICodexHeaders(credentials))) {
			console.log(`${name}: ${value}`);
		}
	}
}

async function runOpenAICodexAuth(args: AuthArgs): Promise<void> {
	const storage = new JsonOpenAICodexAuthStorage({ path: args.authFile });
	const client = new OpenAICodexOAuthClient({ storage });

	if (args.logout) {
		await client.logout();
		console.log(`Cleared OpenAI Codex credentials from ${storage.path}`);
		return;
	}

	if (args.status) {
		const credentials = await storage.get();
		if (!credentials) {
			console.log(`No OpenAI Codex credentials found at ${storage.path}`);
			process.exitCode = 1;
			return;
		}
		printCredentials(credentials, args);
		return;
	}

	if (args.refresh) {
		const credentials = await client.getCredentials();
		if (!credentials) {
			console.log(`No OpenAI Codex credentials found at ${storage.path}`);
			process.exitCode = 1;
			return;
		}
		console.log(`Refreshed OpenAI Codex credentials in ${storage.path}`);
		printCredentials(credentials, args);
		return;
	}

	const credentials = await client.login({
		originator: args.originator,
		onAuth: (info) => {
			console.log(info.instructions ?? "Complete OpenAI Codex authentication in your browser.");
			console.log(info.url);
			if (args.browser !== false) {
				void openBrowser(info.url).catch((error) => {
					console.warn(`Failed to open browser: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		},
		onPrompt: async (prompt) => promptLine(prompt.message),
		onManualCodeInput: args.manual
			? async () => promptLine("Paste the redirect URL or authorization code, or wait for browser callback:")
			: undefined,
	});

	console.log(`Saved OpenAI Codex credentials to ${storage.path}`);
	printCredentials(credentials, args);
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
			.option("auth-file", {
				type: "string",
				describe: "path to auth.json (defaults to CODEWORK_AIKIT_AUTH_FILE or ~/.codework/aikit/auth.json)",
			})
			.option("browser", {
				type: "boolean",
				default: true,
				describe: "open the authorization URL in the default browser",
			})
			.option("manual", {
				type: "boolean",
				default: false,
				describe: "also prompt for a pasted redirect URL or authorization code",
			})
			.option("originator", {
				type: "string",
				default: "codework",
				describe: "OAuth originator value",
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
			.option("print-headers", {
				type: "boolean",
				describe: "print request headers for Codex API calls",
			})
			.check((args) => {
				if (!args.openaiCodex) throw new Error("Choose an auth provider, for example: auth --openai-codex");
				const actions = [args.status, args.refresh, args.logout].filter(Boolean).length;
				if (actions > 1) throw new Error("Choose only one of --status, --refresh, or --logout");
				return true;
			}),
	handler: async (args) => {
		await runOpenAICodexAuth(args);
	},
};
