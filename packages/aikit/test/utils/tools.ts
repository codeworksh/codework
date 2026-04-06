import { Type } from "@sinclair/typebox";
import { Message } from "../../src/message/message";

export const searchTool = Message.defineTool({
	name: "search",
	description: "Search documents",
	parameters: Type.Object({
		query: Type.String(),
		limit: Type.Optional(Type.Number()),
		includeArchived: Type.Optional(Type.Boolean()),
	}),
});

export const calculatorTool = Message.defineTool({
	name: "calculator",
	description: "Calculates mathematical expressions",
	parameters: Type.Object({
		expression: Type.String({
			description: "The mathematical expression to evaluate",
		}),
	}),
});
