import * as Diff from "diff";

/**
 * Exact-text replacement and diff rendering for the edit tool. Matching tries
 * the exact text first, then a fuzzy form that forgives what models commonly get
 * wrong (trailing whitespace, smart quotes, Unicode dashes and spaces) while
 * writing back the file's own bytes for every line no edit touched.
 */

export interface Edit {
	readonly oldText: string;
	readonly newText: string;
}

export const detectLineEnding = (content: string): "\r\n" | "\n" => {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
};

export const normalizeToLF = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const restoreLineEndings = (text: string, ending: "\r\n" | "\n"): string =>
	ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;

/** Strip a UTF-8 BOM if present; the BOM is written back after editing. */
export const stripBom = (content: string): { bom: string; text: string } =>
	content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };

/**
 * The form both sides are compared in when the exact text is not found:
 * NFKC, no trailing whitespace per line, ASCII quotes, dashes and spaces.
 */
export const normalizeForFuzzyMatch = (text: string): string =>
	text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[  -   　]/g, " ");

const splitLinesWithEndings = (content: string): Array<string> => content.match(/[^\n]*\n|[^\n]+/g) ?? [];

interface LineSpan {
	readonly start: number;
	readonly end: number;
}

interface TextReplacement {
	readonly matchIndex: number;
	readonly matchLength: number;
	readonly newText: string;
}

interface MatchedEdit extends TextReplacement {
	readonly editIndex: number;
}

const getLineSpans = (content: string): Array<LineSpan> => {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
};

const getReplacementLineRange = (lines: ReadonlyArray<LineSpan>, replacement: TextReplacement) => {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;
	const startLine = lines.findIndex((line) => replacementStart >= line.start && replacementStart < line.end);
	if (startLine === -1) throw new Error("Replacement range is outside the base content.");
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine]!.end < replacementEnd) endLine++;
	if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
	return { startLine, endLine: endLine + 1 };
};

const applyReplacements = (content: string, replacements: ReadonlyArray<TextReplacement>, offset = 0): string => {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i]!;
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
};

/**
 * Apply replacements matched against `baseContent`, a normalized view of
 * `originalContent`: the lines a replacement touches are rewritten from the
 * normalized base, every other line is copied back from the original. The
 * replacement ranges drive this, so duplicate normalized lines cannot be
 * aligned to the wrong occurrence.
 */
export const applyReplacementsPreservingUnchangedLines = (
	originalContent: string,
	baseContent: string,
	replacements: ReadonlyArray<TextReplacement>,
): string => {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: Array<TextReplacement> }> = [];
	for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const groupStartOffset = baseLines[group.startLine]!.start;
		const groupEndOffset = baseLines[group.endLine - 1]!.end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	return result + originalLines.slice(originalLineIndex).join("");
};

export interface FuzzyMatchResult {
	readonly found: boolean;
	/** Where the match starts, in `contentForReplacement`. */
	readonly index: number;
	readonly matchLength: number;
	readonly usedFuzzyMatch: boolean;
	/** The original content for an exact match; its fuzzy-normalized form for a fuzzy one. */
	readonly contentForReplacement: string;
}

/** Find `oldText`, exactly first, then in fuzzy-normalized space. */
export const fuzzyFindText = (content: string, oldText: string): FuzzyMatchResult => {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
};

const countOccurrences = (content: string, oldText: string): number =>
	normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;

const notFound = (path: string, editIndex: number, totalEdits: number) =>
	totalEdits === 1
		? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
		: `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;

const duplicate = (path: string, editIndex: number, totalEdits: number, occurrences: number) =>
	totalEdits === 1
		? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
		: `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`;

const emptyOldText = (path: string, editIndex: number, totalEdits: number) =>
	totalEdits === 1
		? `oldText must not be empty in ${path}.`
		: `edits[${editIndex}].oldText must not be empty in ${path}.`;

const noChange = (path: string, totalEdits: number) =>
	totalEdits === 1
		? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
		: `No changes made to ${path}. The replacements produced identical content.`;

/**
 * Apply exact-text replacements to LF-normalized content. Every edit is matched
 * against the same original, then applied last to first so offsets stay valid.
 * If any edit needs fuzzy matching, all run in fuzzy space and only the touched
 * lines are written from it. Throws, with the message the model reads, when an
 * edit is empty, missing, ambiguous, overlapping, or changes nothing.
 */
export const applyEditsToNormalizedContent = (
	normalizedContent: string,
	edits: ReadonlyArray<Edit>,
	path: string,
): { baseContent: string; newContent: string } => {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
	normalizedEdits.forEach((edit, i) => {
		if (edit.oldText.length === 0) throw new Error(emptyOldText(path, i, normalizedEdits.length));
	});

	const usedFuzzyMatch = normalizedEdits.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: Array<MatchedEdit> = normalizedEdits.map((edit, i) => {
		const match = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!match.found) throw new Error(notFound(path, i, normalizedEdits.length));
		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) throw new Error(duplicate(path, i, normalizedEdits.length, occurrences));
		return { editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
	});

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1]!;
		const current = matchedEdits[i]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);
	if (normalizedContent === newContent) throw new Error(noChange(path, normalizedEdits.length));
	return { baseContent: normalizedContent, newContent };
};

/** A standard unified patch. */
export const generateUnifiedPatch = (path: string, oldContent: string, newContent: string, contextLines = 4): string =>
	Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});

/**
 * A display diff with line numbers and `contextLines` of context around each
 * change, plus the first changed line in the new file.
 */
export const generateDiffString = (
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } => {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: Array<string> = [];
	const lineNumWidth = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	const numbered = (prefix: string, lineNum: number, line: string) =>
		`${prefix}${String(lineNum).padStart(lineNumWidth, " ")} ${line}`;
	const ellipsis = ` ${"".padStart(lineNumWidth, " ")} ...`;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	parts.forEach((part, i) => {
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			firstChangedLine ??= newLineNum;
			for (const line of raw) {
				if (part.added) output.push(numbered("+", newLineNum++, line));
				else output.push(numbered("-", oldLineNum++, line));
			}
			lastWasChange = true;
			return;
		}

		const context = (lines: ReadonlyArray<string>) => {
			for (const line of lines) {
				output.push(numbered(" ", oldLineNum, line));
				oldLineNum++;
				newLineNum++;
			}
		};
		const skip = (count: number) => {
			output.push(ellipsis);
			oldLineNum += count;
			newLineNum += count;
		};
		const next = parts[i + 1];
		const hasTrailingChange = next !== undefined && (next.added || next.removed);

		if (lastWasChange && hasTrailingChange) {
			if (raw.length <= contextLines * 2) context(raw);
			else {
				context(raw.slice(0, contextLines));
				skip(raw.length - contextLines * 2);
				context(raw.slice(raw.length - contextLines));
			}
		} else if (lastWasChange) {
			context(raw.slice(0, contextLines));
			if (raw.length > contextLines) skip(raw.length - contextLines);
		} else if (hasTrailingChange) {
			const skipped = Math.max(0, raw.length - contextLines);
			if (skipped > 0) skip(skipped);
			context(raw.slice(skipped));
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	});

	return { diff: output.join("\n"), firstChangedLine };
};

export * as EditDiff from "./diff.ts";
