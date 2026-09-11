import type { PromptRegistry } from "./schema.ts";

export const make = () => {
	let open = true;
	let value: string | undefined;
	const registry: PromptRegistry = Object.freeze({
		set: (prompt: string) => {
			if (!open) throw new Error("Prompt registry is closed");
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
