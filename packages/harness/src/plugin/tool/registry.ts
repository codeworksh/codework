import type { RegisteredTool } from "../../tools/tool.ts";
import type { ToolAddOptions, ToolDefPatch, ToolRegistration, ToolRegistry } from "./schema.ts";

const definition = (tool: RegisteredTool): RegisteredTool => ({
	...tool,
	definition: Object.freeze({
		...tool.definition,
		...(tool.definition.promptGuidelines === undefined
			? {}
			: {
					promptGuidelines: Object.freeze([...tool.definition.promptGuidelines]),
				}),
	}),
});

export const make = () => {
	let open = true;
	const entries = new Map<string, ToolRegistration>();
	const assertOpen = () => {
		if (!open) throw new Error("Tool registry is closed");
	};
	const registry: ToolRegistry = Object.freeze({
		add: (tool: RegisteredTool, hooks: ToolAddOptions = {}) => {
			assertOpen();
			entries.set(
				tool.definition.name,
				Object.freeze({ tool: definition(tool), hooks: Object.freeze({ ...hooks }) }),
			);
		},
		update: (name: string, patch: ToolDefPatch) => {
			assertOpen();
			const current = entries.get(name);
			if (!current) throw new Error(`Unknown tool: ${name}`);
			entries.set(
				name,
				Object.freeze({
					...current,
					tool: definition({
						...current.tool,
						definition: {
							...current.tool.definition,
							...(patch.description === undefined ? {} : { description: patch.description }),
							...(patch.label === undefined ? {} : { label: patch.label }),
							...(patch.promptSnippet === undefined ? {} : { promptSnippet: patch.promptSnippet }),
							...(patch.promptGuidelines === undefined ? {} : { promptGuidelines: patch.promptGuidelines }),
						},
					}),
				}),
			);
		},
		list: () => Object.freeze([...entries.values()].map(({ tool }) => tool.definition)),
		get: (name: string) => entries.get(name)?.tool.definition,
		has: (name: string) => entries.has(name),
	});
	return {
		registry,
		close: () => {
			open = false;
		},
		entries: () => Object.freeze([...entries.values()]),
	};
};
