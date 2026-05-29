/**
 * @description Helper function to parse partial jsons during LLM streaming.
 */

import { parse as partialParse } from "partial-json";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		const repaired = repairInvalidJsonStringContent(partialJson);
		if (repaired !== partialJson) {
			try {
				return JSON.parse(repaired) as T;
			} catch {
				try {
					const result = partialParse(repaired);
					return (result ?? {}) as T;
				} catch {
					// Fall through to the original partial parser.
				}
			}
		}

		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}

function repairInvalidJsonStringContent(input: string): string {
	let output = "";
	let inString = false;
	let escaping = false;

	for (const char of input) {
		if (!inString) {
			output += char;
			if (char === '"') inString = true;
			continue;
		}

		if (escaping) {
			if (`"\\/bfnrtu`.includes(char)) {
				output += `\\${char}`;
			} else {
				output += `\\\\${char}`;
			}
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (char === '"') {
			inString = false;
			output += char;
			continue;
		}

		switch (char) {
			case "\b":
				output += "\\b";
				break;
			case "\f":
				output += "\\f";
				break;
			case "\n":
				output += "\\n";
				break;
			case "\r":
				output += "\\r";
				break;
			case "\t":
				output += "\\t";
				break;
			default:
				output += char;
				break;
		}
	}

	if (escaping) output += "\\\\";
	return output;
}
