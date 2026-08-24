#!/usr/bin/env node

import { generateModels } from "@codeworksh/aikit/modelgen";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { Harness } from "../effect/harness.ts";
import { Sandbox } from "../effect/sandbox.ts";
import { Session } from "../effect/session.ts";
import type { EventSchema } from "../event/schema.ts";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const sandboxDrivers = ["local", "daytona", "vercel"] as const;

const writeOut = (value: string) => Effect.sync(() => void process.stdout.write(value));
const writeError = (value: string) => Effect.sync(() => void process.stderr.write(value));

class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("CLI.InvalidInputError", {
	message: Schema.String,
}) {}

class ModelgenError extends Schema.TaggedError<ModelgenError>()("CLI.ModelgenError", {
	cause: Schema.Defect(),
}) {}

const render = (ended: Queue.Queue<string>) =>
	Effect.fn("CLI.render")(function* (event: EventSchema.Payload) {
		if (event.type === "session.llm.text.delta") {
			yield* writeOut((event.data as { readonly delta: string }).delta);
			return;
		}
		if (event.type === "session.turn.ended") {
			yield* Queue.offer(ended, (event.data as { readonly messageId: string }).messageId);
		}
	});

const awaitMessage = Effect.fn("CLI.awaitMessage")(function* (ended: Queue.Queue<string>, messageId: string) {
	while ((yield* Queue.take(ended)) !== messageId) {
		// Earlier turns in the same drain are expected when a tool call continues.
	}
});

const selectSandbox = Effect.fn("CLI.selectSandbox")(function* (
	driver: (typeof sandboxDrivers)[number],
	providerResourceId?: string,
) {
	if (driver === "local") return undefined;
	if (driver === "daytona") {
		return providerResourceId === undefined
			? yield* Sandbox.create({ driver })
			: yield* Sandbox.register({ driver, providerResourceId });
	}
	return providerResourceId === undefined
		? yield* Sandbox.create({ driver })
		: yield* Sandbox.register({ driver, providerResourceId });
});

const root = Command.make("codework").pipe(
	Command.withSharedFlags({
		home: Flag.string("home").pipe(Flag.withDescription("Harness data directory"), Flag.optional),
		database: Flag.string("database").pipe(Flag.withDescription("SQLite path or :memory:"), Flag.optional),
	}),
	Command.withDescription("Run Codework agent sessions"),
);

const run = Command.make(
	"run",
	{
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
		sandbox: Flag.choice("sandbox", sandboxDrivers).pipe(
			Flag.withDescription("Sandbox for a new session (default: local)"),
			Flag.optional,
		),
		sandboxProviderId: Flag.string("sandbox-provider-id").pipe(
			Flag.withDescription("Provider ID of an existing sandbox"),
			Flag.optional,
		),
		provider: Flag.string("provider").pipe(Flag.withDescription("Model catalog provider ID"), Flag.optional),
		model: Flag.string("model").pipe(Flag.withDescription("Model ID"), Flag.optional),
		thinking: Flag.choice("thinking", thinkingLevels).pipe(Flag.withDescription("Thinking level"), Flag.optional),
	},
	Effect.fn("CLI.run")(function* ({ prompt, session, cwd, sandbox, sandboxProviderId, provider, model, thinking }) {
		const shared = yield* root;
		if (
			Option.isSome(session) &&
			(Option.isSome(cwd) || Option.isSome(sandbox) || Option.isSome(sandboxProviderId))
		) {
			return yield* new InvalidInputError({
				message: "--cwd, --sandbox, and --sandbox-provider-id can only be used when creating a new session",
			});
		}
		if (Option.isSome(provider) !== Option.isSome(model)) {
			return yield* new InvalidInputError({ message: "--provider and --model must be provided together" });
		}
		if (Option.isSome(sandboxProviderId) && (Option.isNone(sandbox) || sandbox.value === "local")) {
			return yield* new InvalidInputError({ message: "--sandbox-provider-id requires a remote --sandbox" });
		}
		const program = Effect.gen(function* () {
			const runtime = {
				...(Option.isNone(provider) || Option.isNone(model)
					? {}
					: { model: { provider: provider.value, id: model.value } }),
				...(Option.isNone(thinking) ? {} : { thinkingLevel: thinking.value }),
			};
			let handle: Session.Handle;
			if (Option.isSome(session)) {
				handle = yield* Session.attach({ sessionId: Session.SessionSchema.ID.make(session.value), ...runtime });
			} else {
				const selectedSandbox = Option.getOrElse(sandbox, () => "local" as const);
				const selected = yield* selectSandbox(selectedSandbox, Option.getOrUndefined(sandboxProviderId));
				handle = yield* Session.create({
					title: "CLI",
					...runtime,
					...(selected === undefined ? {} : { sandbox: selected }),
					...(Option.isNone(cwd) ? {} : { directory: cwd.value }),
				});
			}
			const ended = yield* Queue.unbounded<string>();
			const printer = yield* handle
				.events()
				.pipe(Stream.runForEach(render(ended)), Effect.forkScoped({ startImmediately: true }));

			yield* writeError(`session ${handle.id}\n`);
			yield* handle.run(prompt);
			const path = yield* handle.path();
			const leaf = path.at(-1);
			if (leaf !== undefined) yield* awaitMessage(ended, leaf.entry.id);
			yield* Fiber.interrupt(printer);
			yield* writeOut("\n");
		});

		return yield* program.pipe(
			Effect.provide(
				Harness.layer({
					...(Option.isNone(shared.home) ? {} : { home: shared.home.value }),
					...(Option.isNone(shared.database) ? {} : { database: shared.database.value }),
					sandboxes: [Sandbox.Drivers.daytona(), Sandbox.Drivers.vercel()],
				}),
			),
			Effect.scoped,
		);
	}),
).pipe(
	Command.withDescription("Start or continue an agent session"),
	Command.withExamples([
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
	]),
);

const modelgen = Command.make(
	"modelgen",
	{
		path: Argument.string("path").pipe(
			Argument.withDescription("Output path; defaults to CODEWORK_MODELS_FILE or ./models.gen.json"),
			Argument.optional,
		),
	},
	Effect.fn("CLI.modelgen")(function* ({ path }) {
		const generated = yield* Effect.tryPromise({
			try: () => generateModels(Option.isNone(path) ? {} : { path: path.value }),
			catch: (cause) => new ModelgenError({ cause }),
		});
		yield* writeOut(`Generated model catalog at ${generated}\n`);
	}),
).pipe(
	Command.withDescription("Generate the Aikit model catalog"),
	Command.withExamples([{ command: "codework modelgen", description: "Generate models.gen.json" }]),
);

export const command = root.pipe(Command.withSubcommands([run, modelgen]));

export const main: Effect.Effect<void, Command.Error<typeof command> | CliError.CliError> = Command.run(command, {
	version: "0.0.1",
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
