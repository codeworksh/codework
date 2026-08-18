import { Message, Type, llm, stream } from "@codeworksh/aikit";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

async function main() {
	const rl = readline.createInterface({ input, output });

	// Resolve a Google Gemini model
	const model = await llm("google", "gemini-3.5-flash-lite");
	if (!model) throw new Error("Model not found");

	// Define tools with TypeBox schemas for type safety and validation
	const getTimeTool = Message.defineTool({
		name: "get_time",
		description: "Get the current time",
		parameters: Type.Object({
			timezone: Type.Optional(Type.String({ description: "Optional timezone (e.g., Asia/Kolkata)" })),
		}),
	});

	const bashTool = Message.defineTool({
		name: "bash",
		description: "Execute a bash command in the working directory and return its combined stdout/stderr output. ",
		parameters: Type.Object({
			command: Type.String({ description: "The bash command to execute" }),
		}),
	});

	// Setup initial conversation context
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [],
		tools: [getTimeTool, bashTool],
	};

	console.log("Chat started with Gemini! Type your message (or 'exit' to quit).\n");

	while (true) {
		const userInput = await rl.question("user: ");
		if (userInput.trim().toLowerCase() === "exit") {
			break;
		}

		// Add user message to context
		context.messages.push(
			Message.createUserMessage({
				role: "user",
				time: { created: Date.now() },
				parts: [{ type: "text", text: userInput }],
			}),
		);

		try {
			// Get complete response without streaming
			const response = await stream.complete(model, context);

			// Add assistant response to context for future messages
			context.messages.push(response);

			process.stdout.write("assistant: ");
			for (const part of response.parts) {
				if (part.type === "text") {
					console.log(part.text);
				} else if (part.type === "toolCall") {
					console.log(`\n[Tool Call]: ${part.name}(${JSON.stringify(part.arguments)})`);
				}
			}
			console.log(); // Add an empty line for better readability
		} catch (error) {
			console.error("Error communicating with model:", error);
		}
	}

	rl.close();
}

main().catch(console.error);
