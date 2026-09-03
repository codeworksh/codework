import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type { CommandError } from "../cli/error.ts";
import { Spec } from "./spec.ts";

/**
 * Binds handlers to a {@link Spec} tree. Handlers are loaded through dynamic
 * imports so that starting the process -- or printing `--help` -- never pulls in
 * the harness, its sandbox drivers, or the model catalog.
 */

/** Recovers the parsed input type of a spec node, for typing its handler. */
export type Input<Value> =
	Value extends Spec.Node<infer _Name, infer Spec, infer _Commands>
		? Input<Spec>
		: Value extends Command.Command<infer _Name, infer Parsed, infer _Context, infer _Error, infer _Requirements>
			? Parsed
			: never;

/**
 * A handler may yield an ancestor's spec to read its shared flags, which shows up
 * as a `CommandContext` requirement; `withSubcommands` discharges it when the tree
 * is assembled.
 */
type Requirements = Command.Environment | Command.CommandContext<string>;
type Run<Parsed> = (input: Parsed) => Effect.Effect<void, CommandError, Requirements>;
type Loader<Node extends Spec.Any> = () => Promise<{ readonly default: Run<Input<Node>> }>;

/**
 * The handler registry for a spec tree: a loader per leaf, mirroring the shape of
 * the tree. A parent with children takes its own handler under `$`.
 */
export type Handlers<Node extends Spec.Any> = keyof Node["commands"] extends never
	? Loader<Node>
	: { readonly $?: Loader<Node> } & { readonly [Key in keyof Node["commands"]]: Handlers<Node["commands"][Key]> };

interface LazyHandler {
	readonly spec: Command.Command.Any;
	// biome-ignore lint/suspicious/noExplicitAny: input is recovered per-command by `Input`
	readonly load: () => Promise<{ readonly default: Run<any> }>;
}

type LazyHandlers = LazyHandler["load"] | { readonly [key: string]: LazyHandlers | undefined };

type ProvidedCommand = Command.Command<string, unknown, unknown, CommandError, Command.Environment>;

/** Type-checks a handler against the spec node it implements. */
export function handler<const Node extends Spec.Any>(_node: Node, run: Run<Input<Node>>) {
	return run;
}

export function handlers<const Root extends Spec.Any>(
	root: Root,
	handlers: Handlers<Root>,
): ReadonlyArray<LazyHandler> {
	const result: LazyHandler[] = [];

	function add(node: Spec.Any, value: LazyHandlers) {
		if (typeof value === "function") {
			result.push({ spec: node.spec, load: value });
			return;
		}
		if (value.$ !== undefined) result.push({ spec: node.spec, load: value.$ as LazyHandler["load"] });
		for (const [name, child] of Object.entries(node.commands)) {
			const nested = value[name];
			if (nested !== undefined) add(child, nested);
		}
	}

	add(root, handlers as LazyHandlers);
	return result;
}

export function run(root: Spec.Any, handlers: ReadonlyArray<LazyHandler>, options: { readonly version: string }) {
	return Command.run(provide(root, handlers), options);
}

function provide(node: Spec.Any, handlers: ReadonlyArray<LazyHandler>): ProvidedCommand {
	const found = handlers.find((entry) => entry.spec === node.spec);
	const spec = found
		? node.spec.pipe(
				Command.withHandler((input) =>
					Effect.promise(found.load).pipe(Effect.flatMap((module) => module.default(input))),
				),
			)
		: node.spec;
	const children = Object.values(node.commands);
	if (children.length === 0) return spec as ProvidedCommand;
	return spec.pipe(Command.withSubcommands(children.map((child) => provide(child, handlers)))) as ProvidedCommand;
}

export * as Runtime from "./runtime.ts";
