import type { Message } from "@codeworksh/aikit";
import { Effect, type Layer, Schema } from "effect";
import type { TSchema } from "typebox";
import { ToolExecutionError } from "./error.ts";
import type { ToolProgress } from "./progress.ts";

/**
 * The tool definition + handler model.
 *
 * A tool definition is pure, serializable data: name, description, and Effect
 * Schema for parameters / success / failure. Execution is a separate `Handler`
 * — an `Effect` whose capability dependencies (e.g. `ToolShell`) live in its
 * requirements `R`, provided by a Layer at runtime. Separating the two is the
 * main testing win: assert on the definition as plain data, and run the handler
 * against a stub capability Layer.
 *
 * Effect Schema is the single source of truth. {@link toAikitTool} derives a
 * provider-safe JSON Schema object for the aikit wire view; the harness
 * decode/encodes arguments and results with Effect Schema natively (it does not
 * use aikit's Typebox validators).
 */

/** What the model reads next turn (the `content` side of content/details). */
export type ModelContent = ReadonlyArray<Message.TextContent | Message.ImageContent>;

/**
 * Expected failures become a tool-error result fed back to the model ("return");
 * "error" lets them hit the calling effect's error channel. Defaults to
 * "return" in {@link define}.
 *
 * "return" — almost always, for agent tools.
 * 	A bash non-zero exit, a file-not-found, a bad-patch — the model should see these and adapt.
 *
 * "error" — the rare "this failure is fatal to the run"
 * 	case: e.g. an unrecoverable auth/quota error where letting the model keep looping is pointless.
 */
export type FailureMode = "return" | "error";

/** Per-call metadata handed to a handler instead of positional args. */
export interface ToolCallContext {
	readonly callID: string;
	readonly toolName: string;
	readonly rawArgs: Record<string, unknown>;
}

/**
 * A pure tool definition. Parametrised over the *schema* instances so the
 * decoded parameter/success/failure types can be recovered via `["Type"]`.
 */
export interface ToolDef<
	Name extends string = string,
	Params extends Schema.Top = Schema.Top,
	Success extends Schema.Top = Schema.Top,
	Failure extends Schema.Top = Schema.Top,
> {
	readonly name: Name;
	readonly description: string;
	/** Human-readable display label (kept from the previous `AgentTool`). */
	readonly label?: string;
	/**
	 * A short one-line summary for compact tool listings (e.g. a system-prompt tool index),
	 * distinct from the fuller `description`.
	 */
	readonly promptSnippet?: string;
	readonly parameters: Params;
	readonly success: Success;
	/** Declared, model-visible failures (typed). Omit for tools that cannot fail expectedly. */
	readonly failure?: Failure;
	readonly failureMode: FailureMode;
	/** Render success for the model. Omit → executor falls back to JSON text. */
	readonly encodeContent?: (success: Success["Type"]) => ModelContent;
	/** Render an expected failure for the model. Omit → executor falls back to JSON text. */
	readonly encodeFailureContent?: (failure: Failure["Type"]) => ModelContent;
}

/** A handler: validated params + context → typed success or typed failure. */
export type Handler<Params extends Schema.Top, Success extends Schema.Top, Failure extends Schema.Top, R = never> = (
	params: Params["Type"],
	ctx: ToolCallContext,
) => Effect.Effect<Success["Type"], Failure["Type"], R>;

/** A definition paired with its handler (the unit the executor runs). */
export interface ToolImpl<
	Name extends string = string,
	Params extends Schema.Top = Schema.Top,
	Success extends Schema.Top = Schema.Top,
	Failure extends Schema.Top = Schema.Top,
	R = never,
> {
	readonly definition: ToolDef<Name, Params, Success, Failure>;
	readonly handler: Handler<Params, Success, Failure, R>;
}

// Heterogeneous-collection aliases. `any` for the schema generics keeps handlers
// of differing parameter types assignable into one array (the precise generics
// live on the authoring helpers below).
// biome-ignore lint/suspicious/noExplicitAny: erased schema generics for storage
export type AnyToolDef = ToolDef<string, any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: erased schema generics for storage
export type AnyToolImpl<R = never> = ToolImpl<string, any, any, any, R>;

interface DefineInput<
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top,
> {
	readonly name: Name;
	readonly description: string;
	readonly label?: string;
	readonly promptSnippet?: string;
	readonly parameters: Params;
	readonly success: Success;
	readonly failure?: Failure;
	readonly failureMode?: FailureMode;
	readonly encodeContent?: (success: Success["Type"]) => ModelContent;
	readonly encodeFailureContent?: (failure: Failure["Type"]) => ModelContent;
}

/** Define a pure tool (handler attached later via {@link implement} or a toolkit). */
export const define = <
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top = Schema.Top,
>(
	input: DefineInput<Name, Params, Success, Failure>,
): ToolDef<Name, Params, Success, Failure> => ({
	...input,
	failureMode: input.failureMode ?? "return",
});

/** Attach a handler to an existing definition (the testable def/exec split). */
export const implement = <
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top,
	R = never,
>(
	definition: ToolDef<Name, Params, Success, Failure>,
	handler: Handler<Params, Success, Failure, R>,
): ToolImpl<Name, Params, Success, Failure, R> => ({ definition, handler });

/** Sugar for the co-located case: a definition with its handler in one object. */
export const make = <
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top = Schema.Top,
	R = never,
>(
	input: DefineInput<Name, Params, Success, Failure> & {
		readonly handler: Handler<Params, Success, Failure, R>;
	},
): ToolImpl<Name, Params, Success, Failure, R> => {
	const { handler, ...rest } = input;
	return { definition: define(rest), handler };
};

/**
 * A tool ready to register: its capability requirements have been discharged, leaving only
 * the executor-provided {@link ToolProgress}. The registry and executor hold `RegisteredTool`s
 * and are non-generic (only `handle` is generic, over a progress sink's `RProgress`), so any
 * number of tools — built-in or
 * third-party/plugin — compose without a shared capability union
 */
export interface RegisteredTool {
	readonly definition: AnyToolDef;
	readonly handler: (
		params: unknown,
		ctx: ToolCallContext,
	) => Effect.Effect<unknown, ToolExecutionError, ToolProgress>;
}

const toRegistered = <
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top,
>(
	definition: ToolDef<Name, Params, Success, Failure>,
	handler: Handler<Params, Success, Failure, ToolProgress>,
): RegisteredTool => ({
	definition,
	// The executor decodes with `definition.parameters` before invoking this
	// erased handler, so restoring the authored parameter type is safe here.
	handler: (params, ctx) =>
		handler(params as Params["Type"], ctx).pipe(
			Effect.mapError((cause) => new ToolExecutionError({ toolName: definition.name, cause })),
		),
});

/** Register a tool whose only requirement is the executor-provided progress service. */
export const register = <
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top,
>(
	impl: ToolImpl<Name, Params, Success, Failure, ToolProgress>,
): RegisteredTool => toRegistered(impl.definition, impl.handler);

/**
 * Discharge a tool's capability requirements into a {@link RegisteredTool}, erasing its `R`
 * (the executor still provides `ToolProgress`). This is the registration boundary: a
 * plugin/third-party tool provides its own fully-resolved capability Layer here, so the
 * registry never has to unify anyone's `R`.
 */
export const provide = <
	Name extends string,
	Params extends Schema.Top,
	Success extends Schema.Top,
	Failure extends Schema.Top,
	R,
>(
	impl: ToolImpl<Name, Params, Success, Failure, R | ToolProgress>,
	layer: Layer.Layer<R>,
): RegisteredTool =>
	// `Effect.provide` discharges `R`, leaving `ToolProgress`. TS can't simplify
	// `Exclude<ToolProgress, R>` for a generic `R`, so localize the cast before
	// crossing the registered-tool boundary.
	toRegistered(impl.definition, ((params, ctx) => impl.handler(params, ctx).pipe(Effect.provide(layer))) as Handler<
		Params,
		Success,
		Failure,
		ToolProgress
	>);

/**
 * Derive a provider-safe JSON Schema object from an Effect Schema. This is the
 * single boundary that crosses into the provider wire; if a provider rejects a
 * construct, fix it here. Draft-07 inlines the root (no top-level `$ref`).
 */
export const toProviderJsonSchema = (schema: Schema.Top): Record<string, unknown> =>
	Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({ target: "draft-07" });

/**
 * Build the aikit `Message.Tool` wire view from a definition. The derived JSON
 * Schema object satisfies aikit's `parameters` slot structurally at runtime; the
 * single localized cast keeps aikit untouched (decision 3-A).
 */
export const toAikitTool = (def: AnyToolDef): Message.Tool => ({
	name: def.name,
	description: def.description,
	parameters: toProviderJsonSchema(def.parameters) as unknown as TSchema,
});
