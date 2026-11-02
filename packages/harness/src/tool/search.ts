import type { Message } from "@codeworksh/aikit";

/** BM25 ranking over tool metadata: what `toolsearch` loads deferred tools by. */

/** The tool that loads deferred tools. */
export const name = "toolsearch";

/** A tool as the ranker sees it. The name is its own field, so `text` leaves it out. */
export interface Document {
	readonly name: string;
	readonly text: string;
	readonly namespaceText?: string | undefined;
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

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Unicode words, split at camelCase boundaries, lowercase, without stop words; ASCII words in singular form. */
export const tokenize = (text: string): string[] => {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split, and plain ASCII splits into the same words at spaces, so only
	// other text, such as Chinese written without spaces, goes through it.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
};

const K1 = 1.2;
const B = 0.75;

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most `K1 + 1` (2.2) times
 * its IDF and about 1 for a single mention, so a name match beats any number of mentions in the text.
 */
const NAME_WEIGHT = 3;

/** Every tool of a namespace shares its text, so it helps find the namespace but not the tool in it. */
const NAMESPACE_WEIGHT = 0.5;

/** Lowercase with characters invalid in identifiers as `_`, so `dev-radius` matches `dev_radius`. */
const normalizeName = (name: string): string =>
	name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");

/** The whole query is the tool's full name or its name after a `__`: `thread_read` names `mcp__app__thread_read`. */
const isExactName = (query: string, name: string): boolean => {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
};

const indexDocument = (document: Document) => {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		// The part after the last `__` is what models say: `thread`, `read` of `mcp__app__thread_read`.
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]!))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
};

/**
 * Okapi BM25 over `text`, with the name and the namespace as separate fields: the names of the best matches, best
 * first; ties keep document order.
 * - A query that is exactly a tool's name, or its name after a `__`, ranks that tool first.
 * - Then a tool matching more of the query's terms, in any field, ranks above one matching fewer, whatever their
 *   scores: for `screenshot window`, a tool whose description has both words beats `window`, whose name has one.
 * - A tool whose whole local name is in the query gets a bonus worth one more match of every query term, so
 *   `peekaboo app` finds `mcp__peekaboo__app` over tools that only mention the words.
 *
 * Only `text` is length-normalized, so a long name or namespace text does not lower a tool's score.
 */
export const rank = (query: string, documents: ReadonlyArray<Document>, limit: number): string[] => {
	const queryTerms = new Set(tokenize(query));
	if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
	const indexed = documents.map(indexDocument);
	const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
	const idf = new Map(
		[...queryTerms].map((term) => {
			const frequency = indexed.filter(
				(document) =>
					document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
			).length;
			return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
		}),
	);
	const localNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
	const exactQuery = normalizeName(query);
	const matches: { name: string; score: number; covered: number; exact: boolean }[] = [];
	for (const document of indexed) {
		const norm = K1 * (1 - B + (B * document.textLength) / averageLength);
		let score = 0;
		let covered = 0;
		for (const term of queryTerms) {
			const count = document.textCounts.get(term) ?? 0;
			const weight =
				(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
				(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
				(count * (K1 + 1)) / (count + norm);
			if (weight > 0) covered++;
			score += (idf.get(term) ?? 0) * weight;
		}
		if (score === 0) continue;
		const local = document.localNameTerms;
		if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += localNameBonus;
		matches.push({ name: document.name, score, covered, exact: isExactName(exactQuery, document.name) });
	}
	return matches
		.sort(
			(left, right) =>
				Number(right.exact) - Number(left.exact) || right.covered - left.covered || right.score - left.score,
		)
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

/** Search text of a tool: its description and its parameters' text. The ranker reads the name from `name`. */
export const text = (tool: Message.Tool): string => {
	const parts = [tool.description];
	schemaText(tool.parameters, parts);
	return parts.filter((part) => part.trim() !== "").join(" ");
};

export * as ToolSearch from "./search.ts";
