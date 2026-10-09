/**
 * Bounded line reads: one pass over a file that returns a window of its lines
 * without ever holding more than that window.
 *
 * Lines are the file split on `\n`, where a trailing newline ends the last line
 * rather than starting an empty one: `""` has 0 lines, `"a"` and `"a\n"` have 1,
 * `"a\n\n"` has 2. A UTF-8 byte-order mark at the start of the file is not part
 * of the first line. Line lengths are in bytes.
 *
 * Two implementations share these rules, and a backend uses whichever fits:
 * {@link LineScanner} over a byte stream, or {@link script} run inside the
 * sandbox so only the window crosses the network.
 */

export interface LineScanOptions {
	/** First selected line, 0-based. */
	readonly startLine: number;
	/** End of the selection, exclusive; absent selects to the end of the file. */
	readonly endLine?: number;
	/** Most UTF-8 bytes of selected text to return; selection stops at the last whole line that fits. */
	readonly maxBytes: number;
}

export interface LineScan {
	/**
	 * The selected whole lines that fit `maxBytes`, joined with `\n`. Invalid
	 * UTF-8 becomes U+FFFD; how many per bad sequence depends on the decoder of
	 * the backend's transport.
	 */
	readonly text: string;
	/** Lines in {@link text}. */
	readonly lines: number;
	/** Lines in the whole file. */
	readonly totalLines: number;
	/** Bytes in the whole file, byte-order mark included. */
	readonly totalBytes: number;
	/**
	 * Bytes of the first selected line, 0 when nothing is selected. Larger than
	 * `maxBytes` exactly when that line alone does not fit, and `text` is empty.
	 */
	readonly firstLineBytes: number;
}

/** A defect, not a file error: callers derive these from already-validated input. */
export const validate = (options: LineScanOptions): void => {
	const { startLine, endLine, maxBytes } = options;
	if (!Number.isSafeInteger(startLine) || startLine < 0) throw new RangeError(`Invalid startLine: ${startLine}`);
	if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
		throw new RangeError(`Invalid endLine: ${endLine}`);
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError(`Invalid maxBytes: ${maxBytes}`);
};

const NEWLINE = 0x0a;
const BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * Computes a {@link LineScan} from a file's bytes fed in order, in memory
 * bounded by `maxBytes`. Feed at most the file size observed when the read
 * started, so a file that keeps growing cannot keep the scan going.
 */
export class LineScanner {
	private readonly start: number;
	private readonly end: number;
	private readonly maxBytes: number;
	// Only a mark at the very start of the file is dropped, and that happens on
	// the bytes; one starting a later line is text.
	private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });

	/** The first bytes, held until it is known whether they are a byte-order mark. */
	private head: Array<number> | undefined = [];
	private totalBytes = 0;
	private line = 0;
	private lineLength = 0;
	private lineOpen = false;
	/** The current line's bytes, kept only while it is selected and could still fit. */
	private pieces: Array<Uint8Array> = [];
	private selected: Array<Uint8Array> = [];
	private selectedBytes = 0;
	private firstLineBytes = 0;
	private full = false;

	constructor(options: LineScanOptions) {
		validate(options);
		this.start = options.startLine;
		this.end = options.endLine ?? Number.POSITIVE_INFINITY;
		this.maxBytes = options.maxBytes;
	}

	push(chunk: Uint8Array): void {
		this.totalBytes += chunk.length;
		if (this.head !== undefined) {
			const take = Math.min(BOM.length - this.head.length, chunk.length);
			this.head.push(...chunk.subarray(0, take));
			if (this.head.length < BOM.length) return;
			this.releaseHead();
			chunk = chunk.subarray(take);
		}
		this.scan(chunk);
	}

	finish(): LineScan {
		if (this.head !== undefined) this.releaseHead();
		if (this.lineOpen) this.endLine();
		const text = this.selected.map((line) => this.decoder.decode(line)).join("\n");
		return {
			text,
			lines: this.selected.length,
			totalLines: this.line,
			totalBytes: this.totalBytes,
			firstLineBytes: this.firstLineBytes,
		};
	}

	private releaseHead(): void {
		const head = Uint8Array.from(this.head ?? []);
		this.head = undefined;
		const bom = head.length === BOM.length && BOM.every((byte, index) => head[index] === byte);
		if (!bom) this.scan(head);
	}

	private scan(chunk: Uint8Array): void {
		let from = 0;
		while (from < chunk.length) {
			const newline = chunk.indexOf(NEWLINE, from);
			const to = newline === -1 ? chunk.length : newline;
			this.append(chunk.subarray(from, to));
			if (newline === -1) return;
			this.endLine();
			from = newline + 1;
		}
	}

	private isSelected(): boolean {
		return !this.full && this.line >= this.start && this.line < this.end;
	}

	private append(bytes: Uint8Array): void {
		if (bytes.length === 0) {
			this.lineOpen = true;
			return;
		}
		this.lineOpen = true;
		// Past `maxBytes` the line cannot fit, so its bytes are only counted. Copied,
		// not sliced: a Node `Buffer` slice is a view the reader may overwrite.
		if (this.isSelected() && this.lineLength + bytes.length <= this.maxBytes) this.pieces.push(new Uint8Array(bytes));
		this.lineLength += bytes.length;
	}

	private endLine(): void {
		if (this.isSelected()) {
			const first = this.selected.length === 0;
			if (first) this.firstLineBytes = this.lineLength;
			const added = first ? this.lineLength : this.lineLength + 1;
			if (this.selectedBytes + added > this.maxBytes) this.full = true;
			else {
				this.selected.push(concat(this.pieces, this.lineLength));
				this.selectedBytes += added;
			}
		}
		this.pieces = [];
		this.lineLength = 0;
		this.lineOpen = false;
		this.line++;
	}
}

const concat = (pieces: ReadonlyArray<Uint8Array>, length: number): Uint8Array => {
	if (pieces.length === 1) return pieces[0]!;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const piece of pieces) {
		out.set(piece, offset);
		offset += piece.length;
	}
	return out;
};

/**
 * {@link LineScanner} as a POSIX shell script, for backends that only expose a
 * process API. Run as `sh -c <script> _ <path> <startLine> <endLine|-1> <maxBytes>`.
 * The whole file is read inside the sandbox; only the window is printed, after a
 * header line `<lines> <totalLines> <totalBytes> <firstLineBytes>` and before a
 * closing `|` — see {@link parse}.
 * Exits 2 when the path does not exist.
 */
export const script = [
	'[ -e "$1" ] || exit 2',
	// Arithmetic expansion drops the padding some `wc` builds print.
	'size=$(($(wc -c < "$1"))) || exit 1',
	// `C` makes awk's `length` count bytes; `head -c` bounds a file that is still growing.
	'head -c "$size" -- "$1" | LC_ALL=C awk -v s="$2" -v e="$3" -v m="$4" -v size="$size" \'',
	// A file that is only a byte-order mark has no lines; anything after one keeps its own.
	'NR == 1 && $0 == "\\357\\273\\277" && size == 3 { exit }',
	'NR == 1 && substr($0, 1, 3) == "\\357\\273\\277" { $0 = substr($0, 4) }',
	"{ total = NR }",
	"NR > s && (e < 0 || NR <= e) && !full {",
	"  len = length($0)",
	"  added = lines == 0 ? len : len + 1",
	"  if (lines == 0 && !seen) { seen = 1; first = len }",
	"  if (bytes + added > m) { full = 1; next }",
	'  out = lines == 0 ? $0 : out "\\n" $0',
	"  bytes += added; lines++",
	"}",
	// The trailing `|` survives a transport that trims trailing whitespace off stdout.
	// `%.0f`, not `%d`: some mawk builds clamp `%d` to a 32-bit integer.
	'END { printf "%.0f %.0f %.0f %.0f\\n%s|", lines, total, size, first, out }',
	"'",
].join("\n");

/** Arguments for {@link script} after the path. */
export const scriptArgs = (options: LineScanOptions): Array<string> => {
	validate(options);
	return [String(options.startLine), String(options.endLine ?? -1), String(options.maxBytes)];
};

/** Read {@link script}'s output. */
export const parse = (stdout: string): LineScan => {
	const body = stdout.trimEnd();
	const newline = body.indexOf("\n");
	const header = (newline === -1 ? "" : body.slice(0, newline)).trim().split(/\s+/).map(Number);
	const [lines, totalLines, totalBytes, firstLineBytes] = header;
	if (!body.endsWith("|") || header.length !== 4 || header.some((value) => !Number.isSafeInteger(value)))
		throw new Error(`Unexpected scanLines output: ${stdout.slice(0, 200)}`);
	return {
		text: body.slice(newline + 1, -1),
		lines: lines!,
		totalLines: totalLines!,
		totalBytes: totalBytes!,
		firstLineBytes: firstLineBytes!,
	};
};

export interface ShellRun {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr?: string;
}

/**
 * `Provider.scanLines` for a backend that runs an argument vector and collects
 * its output: runs {@link script} in the sandbox and reads the result. A missing
 * path rejects with `ENOENT`, the shape `isNotFoundError` recognises.
 */
export const viaShell =
	(run: (argv: ReadonlyArray<string>) => Promise<ShellRun>) =>
	// oxlint-disable-next-line effecttsgo/async-function -- the Provider contract is Promise-based
	async (path: string, options: LineScanOptions): Promise<LineScan> => {
		const result = await run(["sh", "-c", script, "_", path, ...scriptArgs(options)]);
		if (result.exitCode === 2)
			throw Object.assign(new Error(`ENOENT: no such file or directory, scanLines '${path}'`), { code: "ENOENT" });
		if (result.exitCode !== 0)
			throw new Error(`scanLines failed (exit ${result.exitCode}): ${(result.stderr ?? result.stdout).trim()}`);
		return parse(result.stdout);
	};
