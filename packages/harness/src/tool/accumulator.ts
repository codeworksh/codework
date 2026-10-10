import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, type TruncationResult } from "./truncate.ts";

/**
 * Incrementally accumulates streaming output with bounded memory: chunks are
 * decoded with a streaming UTF-8 decoder and only a rolling decoded *tail* is
 * kept for snapshots, while totals are counted over everything. The full output
 * is never held here; it lives in the sandbox's output file (`Output`).
 *
 * Output that never reached the harness can be accounted for with
 * {@link Accumulator.skip}, so totals and truncation read as if every byte had
 * arrived.
 */

export interface OutputAccumulatorOptions {
	readonly maxLines?: number;
	readonly maxBytes?: number;
}

export interface OutputSnapshot {
	readonly content: string;
	readonly truncation: TruncationResult;
	/**
	 * The raw output exceeds the limits — the rule the sandbox uses to keep its
	 * output file. Decoding can grow invalid UTF-8, so `truncation.truncated` may
	 * be set without it.
	 */
	readonly beyondLimits: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export class Accumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly decoder = new TextDecoder();

	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
	}

	/** `rawBytes` is what `data` measured before a backend decoded it, when that differs. */
	append(data: Uint8Array, rawBytes = data.length): void {
		if (this.finished) throw new Error("cannot append to a finished output accumulator");
		this.totalRawBytes += rawBytes;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));
	}

	/**
	 * Count output that was produced but not delivered — the start of the output,
	 * before anything is appended. Unless it is known to end a line, the first
	 * appended line is treated as partial and left out of snapshots.
	 */
	skip(bytes: number, newlines: number, endsLine: boolean): void {
		if (bytes <= 0) return;
		this.totalRawBytes += bytes;
		this.totalDecodedBytes += bytes;
		this.completedLines += newlines;
		this.totalLines = this.completedLines;
		this.tailStartsAtLineBoundary = endsLine;
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
	}

	snapshot(): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		// Raw bytes, the measure the sandbox applies when it decides to keep the output file.
		const beyondLimits = this.totalLines > this.maxLines || this.totalRawBytes > this.maxBytes;
		const truncated = beyondLimits || tailTruncation.truncated;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalRawBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};
		return { content: truncation.content, truncation, beyondLimits };
	}

	/** Bytes in the final (possibly unterminated) line — for the partial-line footer. */
	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		// Drop the partial first line only when a line follows it; a cut final line is all there is to show.
		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 || firstNewline === this.tailText.length - 1
			? this.tailText
			: this.tailText.slice(firstNewline + 1);
	}
}
