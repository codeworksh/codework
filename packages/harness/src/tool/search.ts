import type { Message } from "@codeworksh/aikit";

/** BM25 ranking over tool metadata: what `toolsearch` loads deferred tools by. */

export interface Document {
	readonly name: string;
	readonly text: string;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
const stem = (term: string): string => {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
};

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export const tokenize = (text: string): string[] =>
	text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);

/** Okapi BM25 (k1 1.2, b 0.75): the names of the best matches, best first; ties keep document order. */
export const rank = (query: string, documents: ReadonlyArray<Document>, limit: number): string[] => {
	const k1 = 1.2;
	const b = 0.75;
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
	const termCounts = documents.map((document) => {
		const counts = new Map<string, number>();
		for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
		return counts;
	});
	const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
	const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
	const idf = new Map(
		queryTerms.map((term) => {
			const frequency = termCounts.filter((counts) => counts.has(term)).length;
			return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
		}),
	);
	const matches: { name: string; score: number }[] = [];
	documents.forEach((document, index) => {
		let score = 0;
		for (const term of queryTerms) {
			const count = termCounts[index]!.get(term);
			if (!count) continue;
			const norm = k1 * (1 - b + (b * lengths[index]!) / averageLength);
			score += (idf.get(term) ?? 0) * ((count * (k1 + 1)) / (count + norm));
		}
		if (score > 0) matches.push({ name: document.name, score });
	});
	return matches
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map((match) => match.name);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Schema descriptions and property names, recursively. */
const schemaText = (schema: unknown, parts: string[]): void => {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
};

/** Search text of a tool: its name, the name with `_` as spaces, its description, and its parameters' text. */
export const text = (tool: Message.Tool): string => {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	return parts.filter((part) => part.trim() !== "").join(" ");
};

export * as ToolSearch from "./search.ts";
