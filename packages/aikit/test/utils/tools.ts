import { type TSchema, Type } from "@sinclair/typebox";
import type { Message } from "../../src/message/message";

export function defineTool<TParameters extends TSchema>(tool: Message.Tool<TParameters>): Message.Tool<TParameters> {
	return tool;
}

export const searchTool = defineTool({
	name: "search",
	description: "Search documents",
	parameters: Type.Object({
		query: Type.String(),
		limit: Type.Optional(Type.Number()),
		includeArchived: Type.Optional(Type.Boolean()),
	}),
});

export const calculatorTool = defineTool({
	name: "calculator",
	description: "Calculates mathematical expressions",
	parameters: Type.Object({
		expression: Type.String({
			description: "The mathematical expression to evaluate",
		}),
	}),
});
