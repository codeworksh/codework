import { EventList, type EventSchema, Harness, Sandbox, Session } from "@codeworksh/harness/effect";
import { Effect, Exit, Fiber, Option, Queue, Ref, Schema, Stream } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { Client } from "../../../server/client.ts";
import { InvalidInputError, renderError } from "../../error.ts";
import { harnessOptions } from "../../harness.ts";
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

const render = (state: Ref.Ref<RenderState>, ended?: Queue.Queue<string>) =>
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
		if (ended !== undefined && isTurnEnded(event)) {
			yield* Queue.offer(ended, event.data.messageId);
		}
	});

const finish = Effect.fn("CLI.finish")(function* (state: Ref.Ref<RenderState>, columns: number) {
	const rendered = yield* Ref.get(state);
	if (rendered.textSeen && !rendered.textEndsWithNewline) yield* writeOut("\n");
	yield* writeError(usage(rendered.usage, columns));
});

const awaitMessage = Effect.fn("CLI.awaitMessage")(function* (ended: Queue.Queue<string>, messageId: string) {
	while ((yield* Queue.take(ended)) !== messageId) {
		// Earlier turns in the same drain are expected when a tool call continues.
	}
});

const selectSandbox = Effect.fn("CLI.selectSandbox")(function* (input: Sandbox.Selection) {
	const selection = yield* Sandbox.resolve(input);
	if (selection.created && selection.info !== undefined) {
		const id = selection.info.id;
		yield* Effect.addFinalizer(() => Effect.ignore(Sandbox.stop(id)));
	}
	return selection.info;
});

export default Runtime.handler(
	Cmd.commands.run,
	Effect.fn("CLI.run")(function* ({
		prompt,
		session,
		cwd,
		sandboxDriver,
		sandboxProviderId,
		sandboxId,
		provider,
		model,
		thinking,
		server,
	}) {
		const shared = yield* Cmd.spec;
		if (
			Option.isSome(session) &&
			(Option.isSome(cwd) ||
				Option.isSome(sandboxDriver) ||
				Option.isSome(sandboxProviderId) ||
				Option.isSome(sandboxId))
		) {
			return yield* new InvalidInputError({
				message:
					"--cwd, --sandbox-driver, --sandbox-id, and --sandbox-provider-id can only be used when creating a new session",
			});
		}
		if (Option.isSome(provider) !== Option.isSome(model)) {
			return yield* new InvalidInputError({ message: "--provider and --model must be provided together" });
		}
		if (Option.isSome(sandboxProviderId) && Option.isNone(sandboxDriver)) {
			return yield* new InvalidInputError({
				message: "--sandbox-provider-id requires a remote --sandbox-driver",
			});
		}
		if (Option.isSome(server) && [shared.home, shared.database, shared.userConfigDir].some(Option.isSome)) {
			return yield* new InvalidInputError({
				message: "--home, --database, and --user-config-dir belong on codework serve when using --server",
			});
		}

		if (Option.isSome(sandboxId) && (Option.isSome(sandboxDriver) || Option.isSome(sandboxProviderId))) {
			return yield* new InvalidInputError({
				message: "--sandbox-id cannot be combined with --sandbox-driver or --sandbox-provider-id",
			});
		}
		const selection: Sandbox.Selection = Option.isSome(sandboxId)
			? { id: Sandbox.SandboxInstance.ID.make(sandboxId.value) }
			: {
					driver: Option.getOrElse(sandboxDriver, () => "local"),
					...(Option.isNone(sandboxProviderId) ? {} : { providerResourceId: sandboxProviderId.value }),
				};

		// The session's host directory, with no flag to set it: a person running a command is always
		// somewhere, and that somewhere is what they mean by "this project". `--cwd` is a different
		// thing entirely -- where the work runs inside the session's space, which may be a sandbox
		// on another machine.
		const hostDir = Session.AbsolutePath.make(process.cwd());

		const runtime = {
			...(Option.isNone(provider) || Option.isNone(model)
				? {}
				: { model: { provider: provider.value, id: model.value } }),
			...(Option.isNone(thinking) ? {} : { thinkingLevel: thinking.value }),
		};
		const remote = Effect.gen(function* () {
			const rpc = yield* Client.make;
			const info = Option.isSome(session)
				? yield* rpc["session.configure"]({ sessionId: Session.SessionSchema.ID.make(session.value), runtime })
				: yield* rpc["session.create"]({
						title: "CLI",
						runtime,
						...(Option.isNone(cwd) ? {} : { directory: cwd.value }),
						hostDir,
						sandbox: selection,
					});
			const state = yield* Ref.make(initialRenderState);
			const columns = terminalColumns();
			yield* writeError(
				header({
					sessionId: info.id,
					sandbox: info.sandbox?.driver ?? "local",
					directory: info.directory,
					columns,
				}),
			);
			if (info.sandbox !== undefined) yield* writeError(`sandbox-id: ${info.sandbox.id}\n`);
			yield* Client.run(rpc, { sessionId: info.id, text: prompt }, render(state)).pipe(
				Effect.onInterrupt(() =>
					rpc["session.interrupt"]({ sessionId: info.id }).pipe(Effect.timeout("5 seconds"), Effect.ignore),
				),
			);
			yield* finish(state, columns);
		});
		const program = Effect.gen(function* () {
			let handle: Session.Handle;
			if (Option.isSome(session)) {
				handle = yield* Session.attach({ sessionId: Session.SessionSchema.ID.make(session.value), ...runtime });
			} else {
				const selected = yield* selectSandbox(selection);
				handle = yield* Session.create({
					title: "CLI",
					...runtime,
					...(selected === undefined ? {} : { sandbox: selected }),
					...(Option.isNone(cwd) ? {} : { directory: cwd.value }),
					hostDir,
				});
			}
			const ended = yield* Queue.unbounded<string>();
			const renderState = yield* Ref.make(initialRenderState);
			const printer = yield* handle
				.events()
				.pipe(Stream.runForEach(render(renderState, ended)), Effect.forkScoped({ startImmediately: true }));

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
			// The local command joins execution to retain typed error details.
			const execution = yield* handle
				.prompt({ text: prompt, delivery: "followUp" })
				.pipe(Effect.andThen(handle.resume()), Effect.exit);
			yield* handle.wait();
			if (Exit.isFailure(execution)) return yield* Effect.failCause(execution.cause);
			const path = yield* handle.path();
			const leaf = path.at(-1);
			if (leaf !== undefined) yield* awaitMessage(ended, leaf.entry.id);
			yield* Fiber.interrupt(printer);
			yield* finish(renderState, columns);
		});

		const execute = Effect.gen(function* () {
			if (Option.isSome(server)) return yield* remote.pipe(Effect.provide(Client.layer(server.value)));
			return yield* program.pipe(Effect.provide(Harness.layer(harnessOptions(shared))));
		});
		return yield* execute.pipe(
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
