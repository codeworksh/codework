import { EventList, type EventSchema, Harness, Sandbox, Session } from "@codeworksh/harness/effect";
import DaytonaSandbox from "@codeworksh/harness/sandboxes/daytona";
import VercelSandbox from "@codeworksh/harness/sandboxes/vercel";
import { Effect, Exit, Fiber, Option, Queue, Ref, Schema, Stream } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { InvalidInputError, renderError } from "../../error.ts";
import {
	addUsage,
	emptyUsage,
	header,
	terminalColumns,
	usage,
	type UsageSummary,
	writeError,
	writeOut,
} from "../../output.ts";
import { Cmd } from "../cmd.ts";

interface RenderState {
	readonly usage: UsageSummary;
	readonly textSeen: boolean;
	readonly textEndsWithNewline: boolean;
}

const initialRenderState: RenderState = {
	usage: emptyUsage,
	textSeen: false,
	textEndsWithNewline: false,
};

const isTextDelta = Schema.is(EventList.LLMTextDelta);
const isLLMEnded = Schema.is(EventList.LLMEnded);
const isTurnEnded = Schema.is(EventList.TurnEnded);

const render = (ended: Queue.Queue<string>, state: Ref.Ref<RenderState>) =>
	Effect.fn("CLI.render")(function* (event: EventSchema.Payload) {
		if (isTextDelta(event)) {
			yield* writeOut(event.data.delta);
			if (event.data.delta.length > 0) {
				yield* Ref.update(state, (current) => ({
					...current,
					textSeen: true,
					textEndsWithNewline: event.data.delta.endsWith("\n"),
				}));
			}
			return;
		}
		if (isLLMEnded(event)) {
			yield* Ref.update(state, (current) => ({ ...current, usage: addUsage(current.usage, event.data.message) }));
			return;
		}
		if (isTurnEnded(event)) {
			yield* Queue.offer(ended, event.data.messageId);
		}
	});

const awaitMessage = Effect.fn("CLI.awaitMessage")(function* (ended: Queue.Queue<string>, messageId: string) {
	while ((yield* Queue.take(ended)) !== messageId) {
		// Earlier turns in the same drain are expected when a tool call continues.
	}
});

const selectSandbox = Effect.fn("CLI.selectSandbox")(function* (driver: string, providerResourceId?: string) {
	if (driver === "local") {
		if (providerResourceId !== undefined) {
			return yield* new InvalidInputError({
				message: "--sandbox-provider-id requires a remote --sandbox",
			});
		}
		return undefined;
	}
	const drivers = yield* Sandbox.drivers();
	const registered = drivers.find((candidate) => candidate.name === driver);
	if (registered === undefined) {
		return yield* new InvalidInputError({
			message: `sandbox driver "${driver}" is not registered (available: local, ${drivers.map(({ name }) => name).join(", ")})`,
		});
	}
	if (providerResourceId !== undefined && registered.kind !== "remote") {
		return yield* new InvalidInputError({
			message: "--sandbox-provider-id requires a remote --sandbox",
		});
	}
	return providerResourceId === undefined
		? yield* Sandbox.create({ driver })
		: yield* Sandbox.register({ driver, providerResourceId });
});

export default Runtime.handler(
	Cmd.commands.run,
	Effect.fn("CLI.run")(function* ({ prompt, session, cwd, sandbox, sandboxProviderId, provider, model, thinking }) {
		const shared = yield* Cmd.spec;
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
		if (Option.isSome(sandboxProviderId) && Option.isNone(sandbox)) {
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
			const renderState = yield* Ref.make(initialRenderState);
			const printer = yield* handle
				.events()
				.pipe(Stream.runForEach(render(ended, renderState)), Effect.forkScoped({ startImmediately: true }));

			const info = yield* handle.info;
			const columns = terminalColumns();
			yield* writeError(
				header({
					sessionId: handle.id,
					sandbox: info.sandbox?.driver ?? "local",
					directory: info.directory,
					columns,
				}),
			);
			// noninteractive client gets typed failures from execution
			// lifecycle events while `wait` only observes idleness. Harness does not
			// publish those lifecycle events yet, so this exclusive process joins the
			// execution started by `prompt`, waits through successors, then restores
			// the joined exit for the existing human-friendly error renderer.
			const execution = yield* handle.prompt(prompt).pipe(Effect.andThen(handle.resume()), Effect.exit);
			yield* handle.wait();
			if (Exit.isFailure(execution)) return yield* Effect.failCause(execution.cause);
			const path = yield* handle.path();
			const leaf = path.at(-1);
			if (leaf !== undefined) yield* awaitMessage(ended, leaf.entry.id);
			yield* Fiber.interrupt(printer);
			const rendered = yield* Ref.get(renderState);
			if (rendered.textSeen && !rendered.textEndsWithNewline) yield* writeOut("\n");
			yield* writeError(usage(rendered.usage, columns));
		});

		return yield* program.pipe(
			Effect.provide(
				Harness.layer({
					...(Option.isNone(shared.home) ? {} : { home: shared.home.value }),
					...(Option.isNone(shared.database) ? {} : { database: shared.database.value }),
					sandboxes: [DaytonaSandbox.make({}), VercelSandbox.make({})],
				}),
			),
			Effect.scoped,
			Effect.catch((error) =>
				writeError(renderError(error)).pipe(
					Effect.andThen(
						Effect.sync(() => {
							process.exitCode = 1;
						}),
					),
				),
			),
		);
	}),
);
