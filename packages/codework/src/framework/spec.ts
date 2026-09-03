import { Command } from "effect/unstable/cli";

/**
 * A declarative command tree. Specs carry only the shape of a command -- its
 * name, parameters, description, and children -- so the whole CLI surface can
 * be read in one file. Handlers are attached separately by {@link Runtime}, which
 * keeps their imports (and the harness they pull in) off the startup path.
 */

export interface Example {
	readonly command: string;
	readonly description: string;
}

interface Options<
	Config extends Command.Command.Config,
	Shared extends Command.Command.FlagConfig,
	Commands extends ReadonlyArray<Any>,
> {
	readonly description?: string;
	readonly params?: Config;
	/** Flags declared here are also parsed by every descendant command. */
	readonly shared?: Shared;
	readonly examples?: ReadonlyArray<Example>;
	readonly commands?: Commands;
}

export interface Node<
	Name extends string,
	// The tree is heterogeneous, so a node has to accept any command shape here.
	// Concrete types are recovered per-command through `Runtime.Input`.
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous command tree
	Spec extends Command.Command<Name, any, any, any, any>,
	Commands extends Children,
> {
	readonly name: Name;
	readonly spec: Spec;
	readonly commands: Commands;
}

// The command name is invariant on `Command`, so the erased node type has to
// admit any name for concrete nodes to be assignable to it.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous command tree
export type Any = Node<string, Command.Command<any, any, any, any, any>, Children>;
export type Children = Readonly<Record<string, Any>>;

type ChildrenOf<Commands extends ReadonlyArray<Any>> = {
	readonly [Node in Commands[number] as Node["name"]]: Node;
};

export function make<
	const Name extends string,
	const Config extends Command.Command.Config = {},
	const Shared extends Command.Command.FlagConfig = {},
	const Commands extends ReadonlyArray<Any> = [],
>(name: Name, options: Options<Config, Shared, Commands> = {}) {
	let spec = Command.make(name, options.params ?? ({} as Config)).pipe(
		Command.withSharedFlags(options.shared ?? ({} as Shared)),
	);
	if (options.description !== undefined) spec = spec.pipe(Command.withDescription(options.description));
	if (options.examples !== undefined) spec = spec.pipe(Command.withExamples(options.examples));
	return {
		name,
		spec,
		commands: Object.fromEntries(
			(options.commands ?? []).map((command) => [command.name, command]),
		) as ChildrenOf<Commands>,
	};
}

export * as Spec from "./spec.ts";
