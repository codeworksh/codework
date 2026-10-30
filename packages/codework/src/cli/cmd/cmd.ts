import { Model } from "@codeworksh/aikit";
import { Schema } from "effect";
import { Argument, Flag } from "effect/cli";
import { Spec } from "../../framework/spec.ts";

/**
 * The full command surface of the `codework` CLI. Declarations only -- each
 * command's behaviour lives in `./handlers`, wired up in `src/index.ts`.
 */

export const thinkingLevels = Object.values(Model.ThinkingLevelEnum);

/**
 * Every `auth` subcommand answers the same three questions: which provider,
 * whose credentials, and where they live. Only `login` needs anything more.
 */
const AuthParams = {
	openaiCodex: Flag.Boolean("openai-codex").pipe(
		Flag.withDescription("Use OpenAI Codex OAuth"),
		Flag.withDefault(false),
	),
	githubCopilot: Flag.Boolean("github-copilot").pipe(
		Flag.withDescription("Use GitHub Copilot OAuth (device flow)"),
		Flag.withDefault(false),
	),
	server: Flag.String("server").pipe(Flag.withDescription("RPC server URL (ws://host:port/rpc/v1)"), Flag.optional),
	authFile: Flag.String("auth-file").pipe(
		Flag.withDescription("Credential file (defaults to <home>/aikit/auth.json)"),
		Flag.optional,
	),
};

/** Where the background server binds when `tui` or `service` has to start one. */
const ServerAddress = {
	host: Flag.String("host").pipe(
		Flag.withDescription("Host interface the background server binds"),
		Flag.withDefault("127.0.0.1"),
	),
	port: Flag.Int("port").pipe(
		Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
		Flag.withDescription("Port the background server listens on"),
		Flag.withDefault(7433),
	),
};

/** For commands that only talk to a server that is already running. */
const RunningServer = Flag.String("server").pipe(
	Flag.withDescription("Base URL of the running codework server"),
	Flag.withDefault("http://127.0.0.1:7433"),
);

/** A thread's MCP server in a running server: every thread sharing its instance is affected. */
const McpControlParams = {
	name: Argument.String("name").pipe(Argument.withDescription("Server name in mcp.json")),
	threadId: Flag.String("threadId").pipe(Flag.withDescription("Thread whose server it is: a thread ID")),
	server: RunningServer,
};

const JsonFlag = Flag.Boolean("json").pipe(
	Flag.withDescription("Print machine-readable output"),
	Flag.withDefault(false),
);

export const Cmd = Spec.make("codework", {
	description: "CodeWork Command Line Interface",
	shared: {
		userConfigDir: Flag.String("user-config-dir").pipe(
			Flag.withDescription("Directory whose settings.jsonc replaces the user settings in --home"),
			Flag.optional,
		),
		home: Flag.String("home").pipe(
			Flag.withDescription("CodeWork home: user settings, credentials, cache and data (default: ~/.codework)"),
			Flag.optional,
		),
		database: Flag.String("database").pipe(Flag.withDescription("SQLite database path or :memory:"), Flag.optional),
	},
	commands: [
		Spec.make("auth", {
			description: "Manage OAuth credentials",
			commands: [
				Spec.make("login", {
					description: "Sign in to a provider",
					params: {
						...AuthParams,
						browser: Flag.Boolean("browser").pipe(
							Flag.withDescription("Open the authorization URL in the default browser"),
							Flag.withDefault(true),
						),
						device: Flag.Boolean("device").pipe(
							Flag.withDescription("Use the device-code flow instead of a localhost browser callback"),
							Flag.withDefault(false),
						),
						enterprise: Flag.String("enterprise").pipe(
							Flag.withDescription("GitHub Enterprise domain for GitHub Copilot login"),
							Flag.optional,
						),
						enableModels: Flag.Boolean("enable-models").pipe(
							Flag.withDescription("Enable unconfigured Copilot catalog models after login"),
							Flag.withDefault(false),
						),
						json: JsonFlag,
					},
					examples: [
						{ command: "codework auth login --openai-codex", description: "Sign in with ChatGPT" },
						{ command: "codework auth login --github-copilot", description: "Sign in with GitHub Copilot" },
						{
							command: "codework auth login --openai-codex --device",
							description: "Sign in with a device code, no local port",
						},
						{
							command: "codework auth login --openai-codex --server ws://127.0.0.1:7433/rpc/v1",
							description: "Sign in the running server",
						},
					],
				}),
				Spec.make("status", {
					description: "Show a stored login without refreshing it",
					params: { ...AuthParams, json: JsonFlag },
					examples: [{ command: "codework auth status --openai-codex", description: "Show the stored login" }],
				}),
				Spec.make("refresh", {
					description: "Refresh a stored login if it has expired",
					params: { ...AuthParams, json: JsonFlag },
					examples: [{ command: "codework auth refresh --openai-codex", description: "Renew an expired login" }],
				}),
				Spec.make("logout", {
					description: "Clear a stored login",
					params: AuthParams,
					examples: [{ command: "codework auth logout --github-copilot", description: "Clear the stored login" }],
				}),
			],
		}),
		Spec.make("mcp", {
			description: "Manage MCP servers",
			commands: [
				Spec.make("add", {
					description: "Add or replace a server in mcp.json",
					params: {
						name: Argument.String("name").pipe(Argument.withDescription("Server name")),
						command: Argument.String("command").pipe(
							Argument.withDescription("Command and arguments of a stdio server, after --"),
							Argument.variadic({ min: 0 }),
						),
						url: Flag.String("url").pipe(
							Flag.withDescription("Streamable HTTP server URL (instead of a command)"),
							Flag.optional,
						),
						env: Flag.KeyValuePair("env").pipe(
							Flag.withDescription("Environment variable of a stdio server, as KEY=VALUE"),
							Flag.optional,
						),
						cwd: Flag.String("cwd").pipe(
							Flag.withDescription("Working directory of a stdio server"),
							Flag.optional,
						),
						header: Flag.KeyValuePair("header").pipe(
							Flag.withDescription("HTTP header, as KEY=VALUE"),
							Flag.optional,
						),
						bearerTokenEnvVar: Flag.String("bearer-token-env-var").pipe(
							Flag.withDescription('Send "Authorization: Bearer ${NAME}"'),
							Flag.optional,
						),
						oauthClientId: Flag.String("oauth-client-id").pipe(
							Flag.withDescription("Pre-registered OAuth client id"),
							Flag.optional,
						),
						oauthClientSecret: Flag.String("oauth-client-secret").pipe(
							Flag.withDescription("OAuth client secret (may be ${NAME} or !command)"),
							Flag.optional,
						),
						oauthCallbackPort: Flag.Int("oauth-callback-port").pipe(
							Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
							Flag.withDescription("Fixed OAuth callback port"),
							Flag.optional,
						),
						oauthClientName: Flag.String("oauth-client-name").pipe(
							Flag.withDescription("Client name sent when registering with the OAuth server"),
							Flag.optional,
						),
						exposure: Flag.Literals("exposure", ["direct", "hidden", "codemode", "deferred"]).pipe(
							Flag.withDescription("How the model reaches the server's tools (default: direct)"),
							Flag.optional,
						),
						description: Flag.String("description").pipe(
							Flag.withDescription("What the server offers"),
							Flag.optional,
						),
						local: Flag.Boolean("local").pipe(
							Flag.withAlias("l"),
							Flag.withDescription("Write the project's .codework/mcp.json instead of the user one"),
							Flag.withDefault(false),
						),
					},
					examples: [
						{
							command: "codework mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .",
							description: "Add a stdio server",
						},
						{
							command: "codework mcp add linear --url https://mcp.linear.app/mcp",
							description: "Add an HTTP server; sign in with codework mcp login linear",
						},
						{
							command: "codework mcp add tools -l --url http://127.0.0.1:8080/mcp",
							description: "Add a server to this project only",
						},
					],
				}),
				Spec.make("remove", {
					description: "Remove a server from mcp.json",
					params: {
						name: Argument.String("name").pipe(Argument.withDescription("Server name in mcp.json")),
						local: Flag.Boolean("local").pipe(
							Flag.withAlias("l"),
							Flag.withDescription("Remove it from the project's .codework/mcp.json instead of the user one"),
							Flag.withDefault(false),
						),
					},
					examples: [{ command: "codework mcp remove linear", description: "Remove the linear server" }],
				}),
				Spec.make("list", {
					description: "Connect to every enabled server and show its state, tools and errors",
					params: { json: JsonFlag },
					examples: [
						{ command: "codework mcp list", description: "Check every configured server; exits 1 on a failure" },
					],
				}),
				Spec.make("login", {
					description: "Sign in to an MCP server with OAuth",
					params: {
						name: Argument.String("name").pipe(Argument.withDescription("Server name in mcp.json")),
						browser: Flag.Boolean("browser").pipe(
							Flag.withDescription("Open the authorization URL in the default browser"),
							Flag.withDefault(true),
						),
						timeout: Flag.Int("timeout").pipe(
							Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
							Flag.withDescription("Seconds the whole sign-in may take"),
							Flag.withDefault(300),
						),
					},
					examples: [
						{ command: "codework mcp login linear", description: "Sign in to the linear server" },
						{
							command: "codework mcp login linear --browser=false",
							description: "Print the URL; paste the redirected URL back if the browser is elsewhere",
						},
					],
				}),
				Spec.make("logout", {
					description: "Remove the stored OAuth credentials of an MCP server",
					params: {
						name: Argument.String("name").pipe(Argument.withDescription("Server name in mcp.json")),
					},
					examples: [{ command: "codework mcp logout linear", description: "Sign out of the linear server" }],
				}),
				Spec.make("reconnect", {
					description: "Connect a thread's MCP server afresh in a running server",
					params: McpControlParams,
					examples: [
						{
							command: "codework mcp reconnect linear --threadId thr_01ja",
							description: "Restart the linear server the thread uses; its tools return from the next turn",
						},
					],
				}),
				Spec.make("disconnect", {
					description: "Close a thread's MCP server in a running server until it is reconnected",
					params: McpControlParams,
					examples: [
						{
							command: "codework mcp disconnect linear --threadId thr_01ja",
							description: "Close the linear server the thread uses",
						},
					],
				}),
			],
		}),
		Spec.make("run", {
			description: "Start or continue an agent session",
			params: {
				server: Flag.String("server").pipe(
					Flag.withDescription("RPC server URL (ws://host:port/rpc/v1)"),
					Flag.optional,
				),
				prompt: Argument.String("prompt").pipe(Argument.withDescription("Prompt for the agent")),
				session: Flag.String("session").pipe(
					Flag.withAlias("s"),
					Flag.withDescription("Continue an existing session"),
					Flag.optional,
				),
				thread: Flag.String("thread").pipe(
					Flag.withDescription("Thread of --session to continue: a thread ID, or main (default)"),
					Flag.optional,
				),
				cwd: Flag.String("cwd").pipe(
					Flag.withAlias("C"),
					Flag.withDescription("Working directory for a new session"),
					Flag.optional,
				),
				sandboxDriver: Flag.String("sandbox-driver").pipe(
					Flag.withDescription("Sandbox driver for a new session (default: local)"),
					Flag.optional,
				),
				sandboxId: Flag.String("sandbox-id").pipe(
					Flag.withDescription("Reuse an existing sandbox instance"),
					Flag.optional,
				),
				sandboxProviderId: Flag.String("sandbox-provider-id").pipe(
					Flag.withDescription("Provider ID of an existing remote sandbox"),
					Flag.optional,
				),
				provider: Flag.String("provider").pipe(Flag.withDescription("Model catalog provider ID"), Flag.optional),
				model: Flag.String("model").pipe(Flag.withDescription("Model ID"), Flag.optional),
				thinking: Flag.Literals("thinking", thinkingLevels).pipe(
					Flag.withDescription("Reasoning effort the model uses before answering"),
					Flag.optional,
				),
			},
			examples: [
				{ command: 'codework run "Inspect the failing tests"', description: "Create a session" },
				{
					command: 'codework run --provider openai --model gpt-5.5 --thinking high "Inspect the failing tests"',
					description: "Create a session with an explicit model",
				},
				{
					command: 'codework run --sandbox-driver daytona "Inspect the repository"',
					description: "Create a Daytona sandbox and session",
				},
				{
					command: 'codework run --sandbox-driver daytona --sandbox-provider-id <id> "Inspect the repository"',
					description: "Use an existing remote sandbox",
				},
				{
					command: 'codework run --session <id> --provider openai --model gpt-5.6-luna "Now fix them"',
					description: "Continue a session with explicit model bindings",
				},
				{
					command: 'codework run --session <id> --thread <thread-id> "Try OAuth instead"',
					description: "Continue one of the session's threads",
				},
			],
		}),
		Spec.make("tui", {
			description: "Launch the CodeWork terminal UI against the background server",
			params: {
				server: Flag.String("server").pipe(
					Flag.withDescription("RPC server URL to use instead of the background server (ws://host:port/rpc/v1)"),
					Flag.optional,
				),
				...ServerAddress,
				args: Argument.variadic(
					Argument.String("args").pipe(Argument.withDescription("Arguments forwarded to the terminal UI")),
				),
			},
			examples: [
				{ command: "codework tui", description: "Start or reuse the local server and open the terminal UI" },
				{
					command: "codework tui --server ws://127.0.0.1:7433/rpc/v1",
					description: "Attach the terminal UI to a server you started yourself",
				},
			],
		}),
		Spec.make("serve", {
			description: "Start the CodeWork RPC server",
			params: {
				host: Flag.String("host").pipe(
					Flag.withDescription("Host interface to bind"),
					Flag.withDefault("127.0.0.1"),
				),
				port: Flag.Int("port").pipe(
					Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
					Flag.withDescription("Port to listen on (0 for an ephemeral port)"),
					Flag.withDefault(7433),
				),
				service: Flag.Boolean("service").pipe(
					Flag.withDescription(
						"Run as the background server `codework tui` manages, logging to <home>/log/server.log",
					),
					Flag.withDefault(false),
				),
			},
			examples: [
				{ command: "codework serve", description: "Start the RPC server on 127.0.0.1:7433" },
				{ command: "codework serve --port 0", description: "Choose an available local port" },
			],
		}),
		Spec.make("service", {
			description: "Manage the background server",
			commands: [
				Spec.make("start", { description: "Start the background server", params: ServerAddress }),
				Spec.make("restart", { description: "Restart the background server", params: ServerAddress }),
				Spec.make("status", { description: "Show background server status" }),
				Spec.make("stop", { description: "Stop the background server" }),
			],
		}),
		Spec.make("session", {
			description: "Manage sessions",
			commands: [
				Spec.make("link", {
					description: "Anchor a session to a host directory",
					params: {
						session: Argument.String("session-id").pipe(Argument.withDescription("The session to link")),
						path: Argument.String("path").pipe(
							// The anchor is not a configuration mechanism, but `.codework` is the landmark
							// a person recognises, so the help names it to make the directory concrete.
							Argument.withDescription(
								"Host directory to anchor to — typically the directory holding your .codework configuration; defaults to the shell's",
							),
							Argument.optional,
						),
						unlink: Flag.Boolean("unlink").pipe(
							Flag.withDescription("Clear the anchor, leaving the session with no host directory"),
							Flag.withDefault(false),
						),
						server: RunningServer,
					},
					examples: [
						{
							command: "codework session link ses_01h9",
							description: "Link it to the directory you are standing in",
						},
						{
							command: "codework session link ses_01h9 ~/work/api",
							description: "Link it to a project elsewhere on this machine",
						},
						{
							command: "codework session link ses_01h9 --unlink",
							description: "Clear the anchor",
						},
					],
				}),
				Spec.make("relink", {
					description: "Move where a session's work, or one thread's, happens",
					params: {
						session: Argument.String("session-id").pipe(Argument.withDescription("The session to move")),
						thread: Flag.String("thread").pipe(
							Flag.withDescription(
								"Move only this thread: a thread ID, or main; omitted moves the session's default",
							),
							Flag.optional,
						),
						directory: Flag.String("directory").pipe(
							Flag.withAlias("C"),
							Flag.withDescription(
								"Checkout to move into; the work keeps its position under it when that path exists there",
							),
							Flag.optional,
						),
						sandboxId: Flag.String("sandbox-id").pipe(
							Flag.withDescription("Sandbox instance to move to (default: local)"),
							Flag.optional,
						),
						json: JsonFlag,
						server: RunningServer,
					},
					examples: [
						{
							command: "codework session relink ses_01h9 -C ~/work/api",
							description: "Move the session to a local checkout",
						},
						{
							command: "codework session relink ses_01h9 --thread thr_01ja --sandbox-id sbx_01k2",
							description: "Run one thread in a sandbox, leaving the others where they are",
						},
					],
				}),
			],
		}),
		Spec.make("thread", {
			description: "Manage a session's threads",
			commands: [
				Spec.make("list", {
					description: "List a session's threads, newest first",
					params: {
						session: Argument.String("session-id").pipe(Argument.withDescription("The session")),
						json: JsonFlag,
						server: RunningServer,
					},
					examples: [{ command: "codework thread list ses_01h9", description: "List the session's threads" }],
				}),
				Spec.make("fork", {
					description: "Start a new thread from a committed entry of a thread's history",
					params: {
						session: Argument.String("session-id").pipe(Argument.withDescription("The session")),
						thread: Flag.String("thread").pipe(
							Flag.withDescription("Thread to fork: a thread ID, or main (default)"),
							Flag.optional,
						),
						at: Flag.String("at").pipe(Flag.withDescription("Keep history through this entry"), Flag.optional),
						before: Flag.String("before").pipe(
							Flag.withDescription("Keep history up to this user entry, and print its text to edit"),
							Flag.optional,
						),
						json: JsonFlag,
						server: RunningServer,
					},
					examples: [
						{
							command: "codework thread fork ses_01h9 --at 01jb",
							description: "Continue the main thread's history through an entry in a new thread",
						},
						{
							command: "codework thread fork ses_01h9 --thread thr_01ja --before 01jc",
							description: "Branch just before a prompt, to send it again differently",
						},
					],
				}),
			],
		}),
		Spec.make("plugin", {
			description: "Manage plugins",
			commands: [
				Spec.make("add", {
					description: "Install a plugin and add it to a settings file",
					params: {
						package: Argument.String("package").pipe(
							Argument.withDescription("Package spec, path, or file: URL"),
						),
						global: Flag.Boolean("global").pipe(
							Flag.withAlias("g"),
							Flag.withDescription("Write the user-wide settings file instead of this project's"),
							Flag.withDefault(false),
						),
						session: Flag.String("session").pipe(
							Flag.withDescription("Write the project a session is linked to, rather than this directory's"),
							Flag.optional,
						),
					},
					examples: [
						{
							command: "codework plugin add @acme/codework-tool-proc@1.2.0",
							description: "Install a published plugin into this project's settings",
						},
						{
							command: "codework plugin add @acme/codework-tool-proc --session ses_01h9",
							description: "Write the project that session is linked to, from anywhere",
						},
						{
							command: "codework plugin add @acme/codework-tool-proc -g",
							description: "Install it for every project this user runs",
						},
					],
				}),
				Spec.make("install", {
					description: "Install every plugin the settings files name",
					params: {},
					examples: [
						{
							command: "codework plugin install",
							description: "Materialise what a fresh checkout already declares",
						},
					],
				}),
				Spec.make("list", {
					description: "List configured plugins and what each one resolved to",
					params: {
						verbose: Flag.Boolean("verbose").pipe(
							Flag.withDescription("Show the message behind a failure, not only its reason"),
							Flag.withDefault(false),
						),
					},
					examples: [{ command: "codework plugin list", description: "Show every configured plugin" }],
				}),
				Spec.make("check", {
					description: "Report which configured plugins have a newer revision available",
					params: {
						spec: Argument.String("spec").pipe(
							Argument.withDescription("Only this configured plugin: a package name or spec, git spec, or path"),
							Argument.optional,
						),
						// An answer is reused for an hour, which is right for a command someone may
						// run repeatedly and wrong for the minute after they pushed a plugin. Without
						// this there is no way to say "ask again", and `check` reports a moving branch
						// as current while `update` — which always refreshes — moves it.
						refresh: Flag.Boolean("refresh").pipe(
							Flag.withDescription("Ask the remote again instead of reusing a recent answer"),
							Flag.withDefault(false),
						),
					},
					examples: [
						{ command: "codework plugin check", description: "Ask the registry what has moved" },
						{ command: "codework plugin check @acme/codework-tool-proc", description: "Ask about one plugin" },
						{
							command: "codework plugin check --refresh",
							description: "Ignore the cached answer, after pushing a plugin",
						},
					],
				}),
				Spec.make("update", {
					description: "Fetch a newer revision of every plugin that has one",
					params: {
						spec: Argument.String("spec").pipe(
							Argument.withDescription("Only this configured plugin: a package name or spec, git spec, or path"),
							Argument.optional,
						),
					},
					examples: [
						{ command: "codework plugin update", description: "Take whatever `check` found" },
						{ command: "codework plugin update @acme/codework-tool-proc", description: "Update one plugin" },
					],
				}),
				Spec.make("reload", {
					description: "Re-import configured plugins in a running server",
					params: {
						server: RunningServer,
					},
					examples: [
						{
							command: "codework plugin reload",
							description: "Pick up edits to a local plugin without restarting",
						},
					],
				}),
				Spec.make("remove", {
					description: "Remove a plugin from a settings file",
					params: {
						package: Argument.String("package").pipe(
							Argument.withDescription("Configured package spec, path, or plugin ID"),
						),
						global: Flag.Boolean("global").pipe(
							Flag.withAlias("g"),
							Flag.withDescription("Edit the user-wide settings file instead of this project's"),
							Flag.withDefault(false),
						),
					},
					examples: [
						{
							command: "codework plugin remove @acme/codework-tool-proc",
							description: "Drop a plugin and any configuration written against it",
						},
					],
				}),
			],
		}),
		Spec.make("models", {
			description: "List or refresh the model catalog",
			params: {
				provider: Flag.String("provider").pipe(Flag.withDescription("Model catalog provider ID"), Flag.optional),
			},
			examples: [
				{ command: "codework models", description: "List all models from all providers" },
				{
					command: "codework models --provider openai",
					description: "List models for a specific provider",
				},
				{ command: "codework models providers", description: "List all available provider IDs" },
			],
			commands: [
				Spec.make("providers", {
					description: "List available model providers in the catalog",
				}),
				Spec.make("refresh", {
					description: "Download the model catalog into the home if it is stale",
					params: {
						force: Flag.Boolean("force").pipe(
							Flag.withDescription("Download it even if it is still fresh"),
							Flag.withDefault(false),
						),
					},
					examples: [
						{ command: "codework models refresh", description: "Refresh a catalog older than 15 minutes" },
						{ command: "codework models refresh --force", description: "Download the catalog now" },
					],
				}),
			],
		}),
		Spec.make("acp", {
			description: "Start the CodeWork Agent Client Protocol (ACP) server over stdio",
			examples: [{ command: "codework acp", description: "Start the ACP server on stdio" }],
		}),
	],
});
