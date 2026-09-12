/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits — whichever is hit first
 * wins: a line limit and a byte limit. Lines are never split (except the bash
 * tail edge case where a single line exceeds the byte limit).
 *
 * The bash tool uses {@link truncateTail} (keep the end — errors / final
 * results); file readers use {@link truncateHead} (keep the beginning).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
	/** The truncated content. */
	content: string;
	/** Whether truncation occurred. */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated. */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content. */
	totalLines: number;
	/** Total number of bytes in the original content. */
	totalBytes: number;
	/** Number of complete lines in the truncated output. */
	outputLines: number;
	/** Number of bytes in the truncated output. */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation). */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation). */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied. */
	maxLines: number;
	/** The max bytes limit that was applied. */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: {@link DEFAULT_MAX_LINES}). */
	maxLines?: number;
	/** Maximum number of bytes (default: {@link DEFAULT_MAX_BYTES}). */
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

/** Format bytes as a human-readable size. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate content from the head (keep the first N lines/bytes). Suitable for
 * file reads where the beginning matters. Never returns partial lines; if the
 * first line alone exceeds the byte limit, returns empty content with
 * `firstLineExceedsLimit = true`.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep the last N lines/bytes). Suitable for
 * bash output where the end matters (errors, final results). May return a
 * partial first line if the last line of the original content exceeds the byte
 * limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// If we haven't added any lines yet and this one exceeds maxBytes,
			// keep the tail of the line (partial).
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end). Handles
 * multi-byte UTF-8 characters correctly (never splits a codepoint).
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Skip maxBytes back from the end, then advance to a valid UTF-8 boundary.
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
		start++;
	}

	return buf.subarray(start).toString("utf-8");
}
