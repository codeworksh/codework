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
