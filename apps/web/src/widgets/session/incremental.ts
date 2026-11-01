import type { Root, RootContent } from "mdast";
import type { Parser as UnifiedParser, Plugin } from "unified";

type Parser = UnifiedParser<Root>;

interface ParsedPrefix {
	readonly source: string;
	readonly offset: number;
	readonly line: number;
	readonly children: RootContent[];
}

const hasDefinitions = (node: Root | RootContent): boolean =>
	node.type === "definition" ||
	node.type === "footnoteDefinition" ||
	("children" in node && node.children.some((child) => hasDefinitions(child)));

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
	if (node.position) {
		for (const point of [node.position.start, node.position.end]) {
			if (point.offset !== undefined) point.offset += offset;
			point.line += lines;
		}
	}
	if ("children" in node) for (const child of node.children) shiftPositions(child, offset, lines);
}

/**
 * Parses a streaming document without re-parsing its finished, code-heavy start on every delta. A
 * closed top-level code fence followed by a blank line ends what can change, so everything up to it
 * is parsed once and reused. Definitions apply document-wide, so a document with any is parsed whole.
 */
function incrementalParser(parse: Parser): Parser {
	let cached: ParsedPrefix | undefined;

	return (source, file) => {
		// A streamed CR can become half of a CRLF, and a BOM at the boundary would be stripped by
		// parsing the rest on its own; either needs the whole document.
		if (source.includes("\r") || source.includes("﻿")) return parse(source, file);

		const prefix = cached !== undefined && source.startsWith(cached.source) ? cached : undefined;
		let root: Root;
		if (prefix !== undefined) {
			root = parse(source.slice(prefix.offset), file);
			if (hasDefinitions(root)) return parse(source, file);
			shiftPositions(root, prefix.offset, prefix.line - 1);
			if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
			// Later transforms mutate the tree they get, so the cache keeps its own copy.
			root.children.unshift(...structuredClone(prefix.children));
		} else {
			root = parse(source, file);
			if (hasDefinitions(root)) return root;
		}

		for (let index = root.children.length - 1; index >= 0; index--) {
			const node = root.children[index];
			if (node?.type !== "code") continue;
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start === undefined || end === undefined) continue;
			if (prefix !== undefined && end < prefix.offset) break;
			const value = source.slice(start, end);
			const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
			if (opening === undefined) continue;
			const lastLine = value.slice(value.lastIndexOf("\n") + 1);
			const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
			const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
			if (!closing.test(lastLine) || separator === undefined) continue;
			const offset = end + separator.length;
			cached = {
				source: source.slice(0, offset),
				offset,
				line: (node.position?.end.line ?? 0) + 2,
				children: structuredClone(root.children.slice(0, index + 1)),
			};
			break;
		}
		return root;
	};
}

/** One per streaming message: its cache belongs to that message's text as it grows. */
export function incrementalMarkdown(): Plugin<[], Root> {
	let parser: Parser | undefined;
	return function () {
		const original = this.parser;
		if (original === undefined) return;
		parser ??= incrementalParser((source, file) => original(source, file) as Root);
		const parseDocument = parser;
		// react-markdown builds a processor per render; only its first parse is the document. Later
		// parses on the same processor are transforms parsing text of their own, kept off the cache.
		let documentParsed = false;
		this.parser = (source, file) => {
			if (documentParsed) return original(source, file);
			documentParsed = true;
			return parseDocument(source, file);
		};
	};
}

// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const documentWide = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
const fenceOpener = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const continuation = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
	if (text.includes("\r") || documentWide.test(text)) return null;
	const blocks: string[] = [];
	let blockStart = 0;
	let lineStart = 0;
	let fence: string | null = null;
	let afterBlankLine = false;
	for (const line of text.split("\n")) {
		const opener = fenceOpener.exec(line)?.[1];
		if (fence !== null) {
			if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
		} else if (line.trim() === "") {
			afterBlankLine = true;
		} else {
			if (afterBlankLine && lineStart > blockStart && !continuation.test(line)) {
				blocks.push(text.slice(blockStart, lineStart));
				blockStart = lineStart;
			}
			afterBlankLine = false;
			fence = opener ?? null;
		}
		lineStart += line.length + 1;
	}
	blocks.push(text.slice(blockStart));
	return blocks;
}
