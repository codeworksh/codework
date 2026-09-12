import { Effect, type FileSystem, type Scope } from "effect";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { fileSystem } from "../host.ts";
import { posix } from "../util/posix.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, type TruncationResult } from "./truncate.ts";

/**
 * Incrementally accumulates streaming output with bounded memory.
 * It decodes chunks with a streaming UTF-8 decoder,
 * keeps only a rolling decoded *tail* for snapshots, and spills the full output
 * to a temp file once it exceeds the display limits — so a multi-gigabyte stream
 * never sits in memory.
 *
 * It is a plain mutable class; the streaming bash handler runs it in an Effect
 * scope, so the spill file handle closes on completion, failure, or interrupt.
 */

export interface OutputAccumulatorOptions {
	readonly maxLines?: number;
	readonly maxBytes?: number;
	readonly tempFilePrefix?: string;
}

export interface OutputSnapshot {
	readonly content: string;
	readonly truncation: TruncationResult;
	readonly fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	return posix.join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export class Accumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
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

	private tempFilePath: string | undefined;
	private tempFile: FileSystem.File | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "codework-output";
	}

	append(data: Buffer): Effect.Effect<void, never, Scope.Scope> {
		return Effect.suspend(() => {
			if (this.finished) return Effect.die(new Error("cannot append to a finished output accumulator"));

			this.totalRawBytes += data.length;
			this.appendDecodedText(this.decoder.decode(data, { stream: true }));

			if (this.tempFile !== undefined || this.shouldUseTempFile()) {
				return Effect.gen({ self: this }, function* () {
					yield* this.ensureTempFile();
					yield* this.tempFile!.writeAll(data).pipe(Effect.orDie);
				});
			}
			if (data.length > 0) this.rawChunks.push(data);
			return Effect.void;
		});
	}

	finish(): Effect.Effect<void, never, Scope.Scope> {
		return Effect.suspend(() => {
			if (this.finished) return Effect.void;
			this.finished = true;
			this.appendDecodedText(this.decoder.decode());
			return Effect.gen({ self: this }, function* () {
				if (this.shouldUseTempFile()) yield* this.ensureTempFile();
				if (this.tempFile !== undefined) yield* this.tempFile.sync.pipe(Effect.orDie);
			});
		});
	}

	snapshot(): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
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

		return {
			content: truncation.content,
			truncation,
			...(this.tempFilePath === undefined ? {} : { fullOutputPath: this.tempFilePath }),
		};
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

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): Effect.Effect<void, never, Scope.Scope> {
		if (this.tempFile !== undefined) return Effect.void;
		return Effect.gen({ self: this }, function* () {
			this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
			this.tempFile = yield* fileSystem.open(this.tempFilePath, { flag: "w" });
			for (const chunk of this.rawChunks) yield* this.tempFile.writeAll(chunk);
			this.rawChunks = [];
		}).pipe(Effect.orDie);
	}
}
