import { Argument, Flag } from "effect/unstable/cli";
import { Spec } from "../../framework/spec.ts";

/**
 * The full command surface of the `codework` CLI. Declarations only -- each
 * command's behaviour lives in `./handlers`, wired up in `src/index.ts`.
 */

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const Cmd = Spec.make("codework", {
	description: "CodeWork command line interface",
	shared: {
		home: Flag.string("home").pipe(Flag.withDescription("Harness data directory"), Flag.optional),
		database: Flag.string("database").pipe(Flag.withDescription("SQLite path or :memory:"), Flag.optional),
	},
	commands: [
		Spec.make("run", {
			description: "Run codework with a prompt",
			params: {
				prompt: Argument.string("prompt").pipe(Argument.withDescription("Prompt for the agent")),
				session: Flag.string("session").pipe(
					Flag.withAlias("s"),
					Flag.withDescription("Continue an existing session ID"),
					Flag.optional,
				),
				cwd: Flag.string("cwd").pipe(
					Flag.withAlias("C"),
					Flag.withDescription("Working directory for a new session"),
					Flag.optional,
				),
				sandbox: Flag.string("sandbox").pipe(
					Flag.withDescription("Registered sandbox driver for a new session (default: local)"),
					Flag.optional,
				),
				sandboxProviderId: Flag.string("sandbox-provider-id").pipe(
					Flag.withDescription("Provider ID of an existing sandbox"),
					Flag.optional,
				),
				provider: Flag.string("provider").pipe(Flag.withDescription("Model catalog provider ID"), Flag.optional),
				model: Flag.string("model").pipe(Flag.withDescription("Model ID"), Flag.optional),
				thinking: Flag.choice("thinking", thinkingLevels).pipe(
					Flag.withDescription("Thinking level"),
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
					command: 'codework run --sandbox daytona "Inspect the repository"',
					description: "Create a Daytona sandbox and session",
				},
				{
					command: 'codework run --sandbox daytona --sandbox-provider-id <id> "Inspect the repository"',
					description: "Use an existing remote sandbox",
				},
				{
					command: 'codework run --session <id> --provider openai --model gpt-5.6-luna "Now fix them"',
					description: "Continue a session with explicit model bindings",
				},
			],
		}),
		Spec.make("modelgen", {
			description: "Generate the model catalog",
			params: {
				path: Argument.string("path").pipe(
					Argument.withDescription("Output path; defaults to CODEWORK_MODELS_FILE or ./models.gen.json"),
					Argument.optional,
				),
			},
			examples: [{ command: "codework modelgen", description: "Generate models.gen.json" }],
		}),
		Spec.make("models", {
			description: "Model catalog management and inspection",
			params: {
				provider: Argument.string("provider").pipe(
					Argument.withDescription("Filter models by provider ID"),
					Argument.optional,
				),
			},
			examples: [
				{ command: "codework models", description: "List all models from all providers" },
				{ command: "codework models openai", description: "List models for a specific provider" },
				{ command: "codework models provider", description: "List all available provider IDs" },
				{ command: "codework models generate", description: "Generate models.gen.json" },
				{ command: "codework models generate .", description: "Generate models.gen.json in current directory" },
				{ command: "codework models generate /path/to/models.gen.json", description: "Generate catalog at explicit path" },
			],
			commands: [
				Spec.make("provider", {
					description: "List available model providers in the catalog",
				}),
				Spec.make("generate", {
					description: "Generate or update the model catalog",
					params: {
						path: Argument.string("path").pipe(
							Argument.withDescription(
								"Output file or directory; defaults to CODEWORK_MODELS_FILE or ./models.gen.json",
							),
							Argument.optional,
						),
					},
					examples: [
						{ command: "codework models generate", description: "Generate models.gen.json" },
						{ command: "codework models generate .", description: "Generate models.gen.json in current directory" },
						{ command: "codework models generate /path/to/models.gen.json", description: "Generate catalog at explicit path" },
					],
				}),
			],
		}),
	],
});
