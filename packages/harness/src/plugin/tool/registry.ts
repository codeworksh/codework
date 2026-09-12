import { Predicate, Schema } from "effect";
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

/**
 * The registration boundary for code the compiler cannot see. A plugin written in
 * plain JS can hand in anything; catching a malformed registration here keeps the
 * failure inside its `setup`, attributed to the plugin, rather than surfacing it
 * later as an unexplained freeze or mid-turn executor defect.
 */
const assertTool = (tool: RegisteredTool) => {
	const def = Predicate.isObject(tool) ? tool.definition : undefined;
	if (!Predicate.isObject(def) || !Predicate.isString(def.name) || def.name.length === 0)
		throw new Error("Registered tool needs a definition with a non-empty string name");
	const name = def.name;
	if (!Schema.isSchema(def.parameters)) throw new Error(`Tool ${name}: parameters must be an Effect Schema`);
	if (!Schema.isSchema(def.success)) throw new Error(`Tool ${name}: success must be an Effect Schema`);
	if (def.failure !== undefined && !Schema.isSchema(def.failure))
		throw new Error(`Tool ${name}: failure must be an Effect Schema`);
	if (def.encodeContent !== undefined && !Predicate.isFunction(def.encodeContent))
		throw new Error(`Tool ${name}: encodeContent must be a function`);
	if (def.encodeFailureContent !== undefined && !Predicate.isFunction(def.encodeFailureContent))
		throw new Error(`Tool ${name}: encodeFailureContent must be a function`);
	if (!Predicate.isFunction(tool.handler)) throw new Error(`Tool ${name}: handler must be a function`);
};

const assertHooks = (name: string, hooks: ToolAddOptions) => {
	if (hooks.beforeToolCall !== undefined && !Predicate.isFunction(hooks.beforeToolCall))
		throw new Error(`Tool ${name}: beforeToolCall must be a function`);
	if (hooks.afterToolCall !== undefined && !Predicate.isFunction(hooks.afterToolCall))
		throw new Error(`Tool ${name}: afterToolCall must be a function`);
};

export const make = () => {
	let open = true;
	const entries = new Map<string, ToolRegistration>();
	const assertOpen = () => {
		if (!open) throw new Error("tool registry is closed");
	};
	const registry: ToolRegistry = Object.freeze({
		add: (tool: RegisteredTool, hooks: ToolAddOptions = {}) => {
			assertOpen();
			assertTool(tool);
			assertHooks(tool.definition.name, hooks);
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
