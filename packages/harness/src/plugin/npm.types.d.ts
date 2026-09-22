/*
 * Declarations for the three npm libraries we call in process. None of them publishes types, and
 * no `@types/*` package exists for them.
 *
 * Deliberately narrow: this is the surface `npm.ts` uses, not the surface these libraries have.
 * A declaration wider than the usage would claim knowledge we have not verified, and the point of
 * writing it out is that every field here is one we checked against the installed copy.
 */

declare module "@npmcli/arborist" {
	interface Node {
		readonly name: string;
		readonly path: string;
		readonly realpath: string;
	}
	interface Tree {
		readonly edgesOut: Map<string, { readonly to?: Node }>;
		readonly inventory: { values(): IterableIterator<Node> };
	}
	export class Arborist {
		constructor(options: Record<string, unknown>);
		reify(options: Record<string, unknown>): Promise<Tree>;
	}
}

declare module "@npmcli/config" {
	export default class Config {
		constructor(options: Record<string, unknown>);
		load(): Promise<void>;
		readonly flat: Record<string, unknown>;
		readonly data: Map<
			string,
			{
				readonly source?: string;
				readonly loadError?: Error & { readonly code?: string };
			}
		>;
	}
}

declare module "@npmcli/config/lib/definitions/index.js" {
	const definitions: {
		readonly definitions: unknown;
		readonly flatten: unknown;
		readonly nerfDarts: unknown;
		readonly shorthands: unknown;
	};
	export default definitions;
}

declare module "pacote" {
	/**
	 * Declared as a default export because that is what `import("pacote")` actually hands back.
	 * pacote is CommonJS and builds `module.exports` in a way Node's named-export detection does
	 * not see through, so `manifest` and `resolve` exist only on `default`. Declaring them as
	 * named exports type-checks and then throws "pacote.resolve is not a function" at runtime --
	 * where `probe` catches it and reports `cannot reach <spec>`, blaming the network.
	 */
	interface Pacote {
		/** The manifest a spec resolves to right now. */
		readonly manifest: (
			spec: string,
			options?: Record<string, unknown>,
		) => Promise<{ readonly version?: string; readonly name?: string }>;
		/** The resolved URL a spec points at; for git it carries `#<sha>`. */
		readonly resolve: (spec: string, options?: Record<string, unknown>) => Promise<string>;
	}
	const pacote: Pacote;
	export default pacote;
}
