import type { PromptRegistry } from "./schema.ts";

/**
 * The system prompt used when no plugin set one.
 *
 * A selection with no prompt plugin is a legitimate configuration -- an embedder
 * passing `plugins: []`, or a user disabling `codework.prompt.default` before
 * their own plugin is ready -- and failing the exchange over it buys nothing the
 * assembled prompt would not already tell them. The real prompt lives in
 * `codework.prompt.default`; this is only the floor.
 */
export const fallback = "You are an AI agent for CodeWork. CodeWork is the best agent harness for code & work.";

export const make = () => {
	let open = true;
	let value: string | undefined;
	const registry: PromptRegistry = Object.freeze({
		set: (prompt: string) => {
			if (!open) throw new Error("prompt registry is closed");
			value = prompt;
		},
		get: () => value,
	});
	return {
		registry,
		close: () => {
			open = false;
		},
		value: () => value,
	};
};
