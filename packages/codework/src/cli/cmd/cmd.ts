import { Schema } from "effect";
import { Model } from "@codeworksh/aikit";
import { Argument, Flag } from "effect/unstable/cli";
import { Spec } from "../../framework/spec.ts";

/**
 * The full command surface of the `codework` CLI. Declarations only -- each
 * command's behaviour lives in `./handlers`, wired up in `src/index.ts`.
 */

export const thinkingLevels = Object.values(Model.ThinkingLevelEnum);

export const Cmd = Spec.make("codework", {
	description: "CodeWork Command Line Interface",
	shared: {
		userConfigDir: Flag.String("user-config-dir").pipe(
			Flag.withDescription("Directory containing user config overrides (e.g. settings.json)"),
			Flag.optional,
		),
		home: Flag.String("home").pipe(
			Flag.withDescription("CodeWork data directory (default: ~/.codework)"),
			Flag.optional,
		),
		database: Flag.String("database").pipe(Flag.withDescription("SQLite database path or :memory:"), Flag.optional),
	},
	commands: [
		Spec.make("run", {
			description: "Start or continue an agent session",
			params: {
				server: Flag.String("server").pipe(
					Flag.withDescription("RPC server URL (ws://host:port/rpc)"),
					Flag.optional,
				),
				prompt: Argument.String("prompt").pipe(Argument.withDescription("Prompt for the agent")),
				session: Flag.String("session").pipe(
					Flag.withAlias("s"),
					Flag.withDescription("Continue an existing session"),
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
			},
			examples: [
				{ command: "codework serve", description: "Start the RPC server on 127.0.0.1:7433" },
				{ command: "codework serve --port 0", description: "Choose an available local port" },
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
					},
					examples: [
						{
							command: "codework plugin add @acme/codework-tool-proc@1.2.0",
							description: "Install a published plugin into this project's settings",
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
					params: {},
					examples: [{ command: "codework plugin check", description: "Ask the registry what has moved" }],
				}),
				Spec.make("update", {
					description: "Fetch a newer revision of every plugin that has one",
					params: {},
					examples: [{ command: "codework plugin update", description: "Take whatever `check` found" }],
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
			description: "List or generate the model catalog",
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
				Spec.make("generate", {
					description: "Generate or update the model catalog",
					params: {
						path: Argument.String("path").pipe(
							Argument.withDescription(
								"Output file or directory; defaults to CODEWORK_MODELS_FILE or ./models.gen.json",
							),
							Argument.optional,
						),
					},
					examples: [
						{ command: "codework models generate", description: "Generate models.gen.json" },
						{
							command: "codework models generate .",
							description: "Generate models.gen.json in the current directory",
						},
						{
							command: "codework models generate /path/to/models.gen.json",
							description: "Generate the catalog at an explicit path",
						},
					],
				}),
			],
		}),
	],
});
