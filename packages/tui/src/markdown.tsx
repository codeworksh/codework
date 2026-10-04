import { Box, Text } from "ink";
import { Spinner } from "./spinner.tsx";

interface MarkdownProps {
	readonly content: string;
	readonly isStreaming?: boolean;
}

interface InlineToken {
	readonly type: "text" | "bold" | "italic" | "code" | "link";
	readonly value: string;
	readonly href?: string;
}

/**
 * Parses inline markdown: `code`, **bold**, *italic*, [text](href)
 */
function parseInline(text: string): readonly InlineToken[] {
	const tokens: InlineToken[] = [];
	const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

	let lastIndex = 0;
	let match: RegExpExecArray | null = regex.exec(text);

	while (match !== null) {
		if (match.index > lastIndex) {
			tokens.push({
				type: "text",
				value: text.slice(lastIndex, match.index),
			});
		}

		const matchText = match[0];
		if (matchText.startsWith("`") && matchText.endsWith("`")) {
			tokens.push({
				type: "code",
				value: matchText.slice(1, -1),
			});
		} else if (
			(matchText.startsWith("**") && matchText.endsWith("**")) ||
			(matchText.startsWith("__") && matchText.endsWith("__"))
		) {
			tokens.push({
				type: "bold",
				value: matchText.slice(2, -2),
			});
		} else if (
			(matchText.startsWith("*") && matchText.endsWith("*")) ||
			(matchText.startsWith("_") && matchText.endsWith("_"))
		) {
			tokens.push({
				type: "italic",
				value: matchText.slice(1, -1),
			});
		} else if (matchText.startsWith("[")) {
			const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(matchText);
			if (linkMatch && linkMatch[1] && linkMatch[2]) {
				tokens.push({
					type: "link",
					value: linkMatch[1],
					href: linkMatch[2],
				});
			} else {
				tokens.push({ type: "text", value: matchText });
			}
		}

		lastIndex = match.index + matchText.length;
		match = regex.exec(text);
	}

	if (lastIndex < text.length) {
		tokens.push({
			type: "text",
			value: text.slice(lastIndex),
		});
	}

	return tokens;
}

function Inline({ text }: { readonly text: string }) {
	const tokens = parseInline(text);

	return (
		<Text>
			{tokens.map((token, idx) => {
				const key = `${token.type}-${idx}`;
				switch (token.type) {
					case "bold":
						return (
							<Text key={key} bold color="#fb923c">
								{token.value}
							</Text>
						);
					case "italic":
						return (
							<Text key={key} italic color="#a1a1aa">
								{token.value}
							</Text>
						);
					case "code":
						return (
							<Text key={key} color="#4ade80">
								{token.value}
							</Text>
						);
					case "link":
						return (
							<Text key={key} color="#06b6d4" underline>
								{token.value}
							</Text>
						);
					default:
						return (
							<Text key={key} color="#f4f4f5">
								{token.value}
							</Text>
						);
				}
			})}
		</Text>
	);
}

type Block =
	| { readonly type: "h1"; readonly text: string }
	| { readonly type: "h2"; readonly text: string }
	| { readonly type: "h3"; readonly text: string }
	| { readonly type: "code"; readonly lang: string; readonly lines: readonly string[] }
	| {
			readonly type: "table";
			readonly headers: readonly string[];
			readonly rows: readonly (readonly string[])[];
			readonly alignments: readonly ("left" | "center" | "right")[];
	  }
	| { readonly type: "ordered-list"; readonly indent: number; readonly num: string; readonly text: string }
	| { readonly type: "bullet-list"; readonly indent: number; readonly text: string }
	| { readonly type: "blockquote"; readonly text: string }
	| { readonly type: "hr" }
	| { readonly type: "paragraph"; readonly text: string }
	| { readonly type: "empty" };

function parseTableRow(line: string): readonly string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.endsWith("|")) {
		trimmed = trimmed.slice(0, -1);
	}
	return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isTableSeparator(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes("-")) return false;
	const cells = parseTableRow(trimmed);
	if (cells.length === 0) return false;
	return cells.every((c) => /^:?-+:?$/.test(c));
}

function parseAlignments(separatorLine: string): readonly ("left" | "center" | "right")[] {
	const cells = parseTableRow(separatorLine);
	return cells.map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});
}

function stripMarkdown(text: string): string {
	return text
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function computeColWidths(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
	maxTableWidth: number,
): readonly number[] {
	const colCount = headers.length;
	if (colCount === 0) return [];

	const borderOverhead = colCount * 3 + 1;
	const availableContentWidth = Math.max(colCount * 3, maxTableWidth - borderOverhead);

	const naturalWidths = headers.map((h, colIdx) => {
		const headerVisLen = stripMarkdown(h).length;
		const maxRowCell = rows.reduce((max, row) => {
			const cellText = row[colIdx] ?? "";
			return Math.max(max, stripMarkdown(cellText).length);
		}, 0);
		return Math.max(headerVisLen, maxRowCell, 3);
	});

	const naturalTotal = naturalWidths.reduce((sum, w) => sum + w, 0);
	if (naturalTotal <= availableContentWidth) {
		return naturalWidths;
	}

	return naturalWidths.map((w) => {
		const scaled = Math.floor((w / naturalTotal) * availableContentWidth);
		return Math.max(3, scaled);
	});
}

function renderTableRow(
	cells: readonly string[],
	colWidths: readonly number[],
	alignments: readonly ("left" | "center" | "right")[],
	isHeader: boolean,
	key: string,
): React.ReactNode {
	return (
		<Box key={key} flexDirection="row">
			<Text color="#3f3f46">│ </Text>
			{colWidths.map((w, cIdx) => {
				const rawCell = cells[cIdx] ?? "";
				const stripped = stripMarkdown(rawCell);
				const visLen = stripped.length;
				let displayCell = rawCell;
				let currentVisLen = visLen;

				if (visLen > w) {
					displayCell = w > 3 ? `${stripped.slice(0, w - 1)}…` : stripped.slice(0, w);
					currentVisLen = displayCell.length;
				}

				const align = alignments[cIdx] ?? "left";
				const padTotal = Math.max(0, w - currentVisLen);
				let leftPad = 0;
				let rightPad = padTotal;

				if (align === "right") {
					leftPad = padTotal;
					rightPad = 0;
				} else if (align === "center") {
					leftPad = Math.floor(padTotal / 2);
					rightPad = padTotal - leftPad;
				}

				const isLastCol = cIdx === colWidths.length - 1;

				return (
					<Box key={`c-${cIdx}`} flexDirection="row">
						{leftPad > 0 && <Text>{" ".repeat(leftPad)}</Text>}
						{isHeader ? (
							<Text bold color="#c084fc">
								{displayCell}
							</Text>
						) : (
							<Inline text={displayCell} />
						)}
						{rightPad > 0 && <Text>{" ".repeat(rightPad)}</Text>}
						<Text color="#3f3f46">{isLastCol ? " │" : " │ "}</Text>
					</Box>
				);
			})}
		</Box>
	);
}

function parseBlocks(raw: string): readonly Block[] {
	const lines = raw.split("\n");
	const blocks: Block[] = [];

	let inCode = false;
	let codeLang = "";
	let codeLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		// Code block toggle
		if (trimmed.startsWith("```")) {
			if (inCode) {
				blocks.push({
					type: "code",
					lang: codeLang,
					lines: codeLines,
				});
				inCode = false;
				codeLang = "";
				codeLines = [];
			} else {
				inCode = true;
				codeLang = trimmed.slice(3).trim();
				codeLines = [];
			}
			continue;
		}

		if (inCode) {
			codeLines.push(line);
			continue;
		}

		if (trimmed === "") {
			blocks.push({ type: "empty" });
			continue;
		}

		// Table detection
		if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
			const headers = parseTableRow(line);
			const alignments = parseAlignments(lines[i + 1]!);
			const tableRows: (readonly string[])[] = [];
			i += 1; // skip separator

			while (i + 1 < lines.length) {
				const nextLine = lines[i + 1]!;
				const nextTrimmed = nextLine.trim();
				if (!nextTrimmed || !nextTrimmed.includes("|")) {
					break;
				}
				i++;
				tableRows.push(parseTableRow(nextLine));
			}

			blocks.push({
				type: "table",
				headers,
				rows: tableRows,
				alignments,
			});
			continue;
		}

		// Horizontal rule
		if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
			blocks.push({ type: "hr" });
			continue;
		}

		// Headings
		if (line.startsWith("# ")) {
			blocks.push({ type: "h1", text: line.slice(2).trim() });
			continue;
		}
		if (line.startsWith("## ")) {
			blocks.push({ type: "h2", text: line.slice(3).trim() });
			continue;
		}
		if (line.startsWith("### ")) {
			blocks.push({ type: "h3", text: line.slice(4).trim() });
			continue;
		}
		if (/^#{4,}\s+/.test(line)) {
			blocks.push({ type: "h3", text: line.replace(/^#{4,}\s+/, "").trim() });
			continue;
		}

		// Blockquote
		if (line.startsWith(">")) {
			blocks.push({ type: "blockquote", text: line.replace(/^>\s?/, "") });
			continue;
		}

		// Ordered list (e.g. "  1. ")
		const orderedMatch = /^(\s*)(\d+)\.\s+(.+)$/.exec(line);
		if (orderedMatch && orderedMatch[1] !== undefined && orderedMatch[2] && orderedMatch[3]) {
			blocks.push({
				type: "ordered-list",
				indent: orderedMatch[1].length,
				num: orderedMatch[2],
				text: orderedMatch[3],
			});
			continue;
		}

		// Bullet list (e.g. "  - " or "  * ")
		const bulletMatch = /^(\s*)[-*+]\s+(.+)$/.exec(line);
		if (bulletMatch && bulletMatch[1] !== undefined && bulletMatch[2]) {
			blocks.push({
				type: "bullet-list",
				indent: bulletMatch[1].length,
				text: bulletMatch[2],
			});
			continue;
		}

		// Normal paragraph line
		blocks.push({ type: "paragraph", text: line });
	}

	// Unclosed code block while streaming
	if (inCode) {
		blocks.push({
			type: "code",
			lang: codeLang,
			lines: codeLines,
		});
	}

	return blocks;
}

export function wrapString(str: string, maxLen: number): readonly string[] {
	if (str.length <= maxLen) return [str];
	const words = str.split(" ");
	const result: string[] = [];
	let cur = "";

	for (const word of words) {
		if (cur.length === 0) {
			cur = word;
		} else if (cur.length + 1 + word.length <= maxLen) {
			cur += ` ${word}`;
		} else {
			result.push(cur);
			cur = word;
		}
	}
	if (cur.length > 0) {
		result.push(cur);
	}
	return result;
}

export function renderMarkdownLines(content: string, isStreaming?: boolean, maxWidth = 80): readonly React.ReactNode[] {
	if (!content && isStreaming) {
		return [
			<Box key="m-think" flexDirection="row">
				<Spinner color="#f59e0b" />
				<Text color="#fbbf24"> Thinking...</Text>
			</Box>,
		];
	}

	const blocks = parseBlocks(content);
	const lines: React.ReactNode[] = [];

	blocks.forEach((block, bIdx) => {
		const isLast = bIdx === blocks.length - 1;
		const key = `b-${bIdx}`;

		switch (block.type) {
			case "h1":
				lines.push(
					<Text key={`${key}-t`} bold color="#c084fc">
						{block.text}
					</Text>,
				);
				break;

			case "h2":
				lines.push(
					<Text key={`${key}-t`} bold color="#c084fc">
						{block.text}
					</Text>,
				);
				break;

			case "h3":
				lines.push(
					<Text key={`${key}-t`} bold color="#c084fc">
						{block.text}
					</Text>,
				);
				break;

			case "code":
				if (block.lang) {
					lines.push(
						<Text key={`${key}-lang`} color="#c084fc" italic>
							{block.lang}
						</Text>,
					);
				}
				block.lines.forEach((cLine, cIdx) => {
					lines.push(
						<Box key={`${key}-c-${cIdx}`} flexDirection="row">
							<Text color="#3f3f46">│ </Text>
							<Text color="#e4e4e7">{cLine || " "}</Text>
						</Box>,
					);
				});
				break;

			case "table": {
				const colWidths = computeColWidths(block.headers, block.rows, maxWidth);
				if (colWidths.length === 0) break;

				const topBorder = `┌─${colWidths.map((w) => "─".repeat(w)).join("─┬─")}─┐`;
				lines.push(
					<Text key={`${key}-tt`} color="#3f3f46">
						{topBorder}
					</Text>,
				);

				lines.push(renderTableRow(block.headers, colWidths, block.alignments, true, `${key}-th`));

				const divider = `├─${colWidths.map((w) => "─".repeat(w)).join("─┼─")}─┤`;
				lines.push(
					<Text key={`${key}-td`} color="#3f3f46">
						{divider}
					</Text>,
				);

				block.rows.forEach((row, rIdx) => {
					lines.push(renderTableRow(row, colWidths, block.alignments, false, `${key}-tr-${rIdx}`));
					if (rIdx < block.rows.length - 1) {
						lines.push(
							<Text key={`${key}-tdiv-${rIdx}`} color="#3f3f46">
								{divider}
							</Text>,
						);
					}
				});

				const bottomBorder = `└─${colWidths.map((w) => "─".repeat(w)).join("─┴─")}─┘`;
				lines.push(
					<Text key={`${key}-tb`} color="#3f3f46">
						{bottomBorder}
					</Text>,
				);
				break;
			}

			case "ordered-list": {
				const sublines = wrapString(block.text, Math.max(20, maxWidth - 6));
				sublines.forEach((sLine, sIdx) => {
					const isLastSub = isLast && sIdx === sublines.length - 1;
					lines.push(
						<Box key={`${key}-ol-${sIdx}`} flexDirection="row" paddingLeft={Math.floor(block.indent / 2)}>
							<Text color="#71717a">{sIdx === 0 ? `${block.num}. ` : "   "}</Text>
							<Inline text={sLine} />
							{isLastSub && isStreaming && <Text color="#06b6d4">▌</Text>}
						</Box>,
					);
				});
				break;
			}

			case "bullet-list": {
				const sublines = wrapString(block.text, Math.max(20, maxWidth - 6));
				sublines.forEach((sLine, sIdx) => {
					const isLastSub = isLast && sIdx === sublines.length - 1;
					lines.push(
						<Box key={`${key}-ul-${sIdx}`} flexDirection="row" paddingLeft={Math.floor(block.indent / 2)}>
							<Text color="#71717a">{sIdx === 0 ? "- " : "  "}</Text>
							<Inline text={sLine} />
							{isLastSub && isStreaming && <Text color="#06b6d4">▌</Text>}
						</Box>,
					);
				});
				break;
			}

			case "blockquote": {
				const sublines = wrapString(block.text, Math.max(20, maxWidth - 4));
				sublines.forEach((sLine, sIdx) => {
					const isLastSub = isLast && sIdx === sublines.length - 1;
					lines.push(
						<Box key={`${key}-bq-${sIdx}`} flexDirection="row" paddingLeft={1}>
							<Text color="#06b6d4">│ </Text>
							<Text color="#a1a1aa" italic>
								{sLine}
							</Text>
							{isLastSub && isStreaming && <Text color="#06b6d4">▌</Text>}
						</Box>,
					);
				});
				break;
			}

			case "hr":
				lines.push(
					<Text key={`${key}-hr`} color="#27272a">
						{"─".repeat(Math.min(maxWidth, 40))}
					</Text>,
				);
				break;

			case "empty":
				lines.push(<Text key={`${key}-em`}> </Text>);
				break;

			case "paragraph":
			default: {
				const sublines = wrapString(block.text, Math.max(20, maxWidth));
				sublines.forEach((sLine, sIdx) => {
					const isLastSub = isLast && sIdx === sublines.length - 1;
					lines.push(
						<Box key={`${key}-p-${sIdx}`} flexDirection="row">
							<Inline text={sLine} />
							{isLastSub && isStreaming && <Text color="#06b6d4">▌</Text>}
						</Box>,
					);
				});
				break;
			}
		}
	});

	return lines;
}

export function Markdown({ content, isStreaming }: MarkdownProps) {
	if (!content && isStreaming) {
		return (
			<Box flexDirection="row">
				<Spinner color="#f59e0b" />
				<Text color="#fbbf24"> Thinking...</Text>
			</Box>
		);
	}

	const lines = renderMarkdownLines(content, isStreaming, 72);

	return (
		<Box flexDirection="column">
			{lines.map((line, idx) => (
				<Box key={`l-${idx}`}>{line}</Box>
			))}
		</Box>
	);
}
