#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { resolve } from "node:path";
import { Harness } from "../effect/harness.ts";
import { Session } from "../effect/session.ts";
import type { EventSchema } from "../event/schema.ts";

const writeOut = (value: string) => Effect.sync(() => void process.stdout.write(value));
const writeError = (value: string) => Effect.sync(() => void process.stderr.write(value));

class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("CLI.InvalidInputError", {
	message: Schema.String,
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
			Flag.withDescription("Working directory for a new local session"),
			Flag.optional,
		),
	},
	Effect.fn("CLI.run")(function* ({ prompt, session, cwd }) {
		const shared = yield* root;
		if (Option.isSome(session) && Option.isSome(cwd)) {
			return yield* new InvalidInputError({ message: "--cwd can only be used when creating a new session" });
		}
		const program = Effect.gen(function* () {
			const handle = Option.isSome(session)
				? yield* Session.attach({ sessionId: Session.SessionSchema.ID.make(session.value) })
				: yield* Session.create({
						title: "CLI",
						...(Option.isNone(cwd) ? {} : { directory: resolve(cwd.value) }),
					});
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
				}),
			),
			Effect.scoped,
		);
	}),
).pipe(
	Command.withDescription("Start or continue a local agent session"),
	Command.withExamples([
		{ command: 'codework run "Inspect the failing tests"', description: "Create a session" },
		{ command: 'codework run --session <id> "Now fix them"', description: "Continue a session" },
	]),
);

export const command = root.pipe(Command.withSubcommands([run]));

export const main: Effect.Effect<void, Command.Error<typeof command> | CliError.CliError> = Command.run(command, {
	version: "0.0.1",
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
