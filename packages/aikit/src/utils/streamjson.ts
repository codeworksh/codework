/**
 * Incremental, tolerant parsing of JSON text that arrives in pieces, such as streamed tool-call arguments.
 *
 * `StreamingJsonParser.append()` reads each piece once, so a stream costs time and memory linear in its length, and
 * `snapshot()` returns the value of the text read so far. Snapshots are plain JSON values and never change once
 * returned: the parser copies the containers that are still open (the "open path") into every new snapshot and shares
 * completed containers and strings. Incomplete text:
 *
 * - An unterminated string shows the characters read so far; an unterminated escape is held back until complete.
 * - An unterminated container shows the members and elements read so far.
 * - A member whose key or value has not started is omitted.
 * - An unterminated literal shows its value once it is a prefix of `true`, `false` or `null`; an unterminated number
 *   shows its value when the digits read so far form a number (an exponent without digits is ignored).
 *
 * Malformed text is read leniently: raw control characters in strings are kept, an invalid escape such as `\d` stays
 * literal text, missing commas and colons are tolerated, values in invalid positions and unknown words are dropped,
 * and text after the root value is ignored. The parser never throws.
 *
 * Cost: copying the open path costs its member and element count. Each `append()` earns copy credit proportional to its
 * length plus a constant; `snapshot()` spends it and returns the previous snapshot while the open path costs more than
 * the credit. So a document that keeps a very large container open shows a preview that lags a little behind the
 * text, and no input makes the total work grow faster than the text.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonContainer = { [key: string]: JsonValue } | JsonValue[];

/** Where a value sits in its parent; absent for a value in an invalid position, which is read but dropped. */
type Slot =
	| { readonly kind: "root" }
	| { readonly kind: "member"; readonly key: string }
	| { readonly kind: "element"; readonly index: number };

/** An open object or array. Its `container` is never handed out while open; snapshots get copies. */
type Frame = {
	readonly container: JsonContainer;
	readonly slot: Slot | undefined;
	/** Members or elements; what a copy of the container costs. */
	size: number;
	/** Objects: the key read last, where the member value goes. */
	key: string | undefined;
	phase: "key" | "colon" | "value" | "comma";
};

/** An unterminated string. */
type OpenString = {
	readonly target: "key" | "value";
	readonly slot: Slot | undefined;
	text: string;
	/** Escape read so far: "" for none, otherwise a backslash and up to five more characters. */
	escape: string;
};

const ROOT_SLOT: Slot = { kind: "root" };
// Copy credit per append and per appended character. The floor keeps small documents fresh at every snapshot.
const CREDIT_PER_APPEND = 256;
const CREDIT_PER_CHARACTER = 8;
// An unterminated number longer than this is not shown until it ends, so `snapshot()` stays cheap.
const MAX_PENDING_SCALAR_LENGTH = 64;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_WITHOUT_EXPONENT_DIGITS = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)[eE][+-]?$/;
const LITERALS: readonly [string, JsonValue][] = [
	["true", true],
	["false", false],
	["null", null],
];

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Incremental, tolerant JSON parser; see the module comment for its rules and costs. */
export class StreamingJsonParser {
	#root: JsonValue | undefined = undefined;
	#done = false;
	readonly #stack: Frame[] = [];
	#string: OpenString | undefined = undefined;
	#scalar = "";
	#scalarSlot: Slot | undefined = undefined;
	/** Sum of `size + 1` over the open path: what a fresh snapshot copies. */
	#pathCost = 0;
	#credit = 0;
	#dirty = false;
	#snapshot: JsonValue | undefined = undefined;

	/** Read the next piece of text. Costs time linear in `text.length`. */
	append(text: string): void {
		this.#credit += CREDIT_PER_APPEND + CREDIT_PER_CHARACTER * text.length;
		let index = 0;
		while (index < text.length && !this.#done) {
			const open = this.#string;
			if (open !== undefined) index = this.#readString(open, text, index);
			else if (this.#scalar !== "") index = this.#readScalar(text, index);
			else this.#structural(text[index++]!);
		}
	}

	/**
	 * The value of the text read so far: `undefined` before a value starts, otherwise a plain JSON value that never
	 * changes afterwards. Returns the previous snapshot while the text read since did not change the value, or while a
	 * fresh copy of the open path is not yet paid for (see the module comment).
	 */
	snapshot(): JsonValue | undefined {
		if (!this.#dirty) return this.#snapshot;
		const pending = this.#pendingScalar();
		const cost = this.#pathCost + (pending === undefined ? 0 : 1);
		if (cost > this.#credit) return this.#snapshot;
		this.#credit -= cost;
		this.#dirty = false;
		this.#snapshot = this.#copyOpenPath(pending);
		return this.#snapshot;
	}

	/** Read string characters from `start` until the string ends or the text does; returns the next index. */
	#readString(open: OpenString, text: string, start: number): number {
		let runStart = start;
		for (let index = start; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (open.escape !== "") {
				if (this.#continueEscape(open, text[index]!)) {
					runStart = index + 1;
					continue;
				}
				// Not part of the escape: read it as a normal string character below.
				runStart = index;
			}
			if (code === QUOTE) {
				if (index > runStart) this.#appendString(open, text.slice(runStart, index));
				this.#endString(open);
				return index + 1;
			}
			if (code === BACKSLASH) {
				if (index > runStart) this.#appendString(open, text.slice(runStart, index));
				open.escape = "\\";
				runStart = index + 1;
			}
		}
		if (text.length > runStart) this.#appendString(open, text.slice(runStart));
		return text.length;
	}

	/** Read number or literal characters from `start` up to the next delimiter; returns the delimiter's index. */
	#readScalar(text: string, start: number): number {
		let end = start;
		while (end < text.length && !isDelimiter(text[end]!)) end++;
		if (end > start) {
			this.#scalar += text.slice(start, end);
			if (this.#scalarSlot !== undefined) this.#dirty = true;
		}
		if (end < text.length) this.#endScalar();
		return end;
	}

	/** Handle one character outside strings. */
	#structural(char: string): void {
		switch (char) {
			case " ":
			case "\t":
			case "\n":
			case "\r":
				return;
			case '"':
				this.#startString();
				return;
			case "{":
			case "[":
				this.#openContainer(char === "{" ? {} : []);
				return;
			case "}":
			case "]":
				this.#closeContainer();
				return;
			case ":": {
				const frame = this.#stack.at(-1);
				if (frame !== undefined && !Array.isArray(frame.container) && frame.phase === "colon")
					frame.phase = "value";
				return;
			}
			case ",": {
				const frame = this.#stack.at(-1);
				if (frame !== undefined) frame.phase = Array.isArray(frame.container) ? "value" : "key";
				return;
			}
			default:
				this.#scalar = char;
				this.#scalarSlot = this.#valueSlot();
				if (this.#scalarSlot !== undefined) this.#dirty = true;
		}
	}

	/** Where a value starting now goes, or `undefined` when this position takes no value. */
	#valueSlot(): Slot | undefined {
		const frame = this.#stack.at(-1);
		if (frame === undefined) return this.#root === undefined ? ROOT_SLOT : undefined;
		if (Array.isArray(frame.container)) return { kind: "element", index: frame.container.length };
		// A missing colon is tolerated: `{"a" 1}` reads as `{"a": 1}`.
		if ((frame.phase === "value" || frame.phase === "colon") && frame.key !== undefined) {
			return { kind: "member", key: frame.key };
		}
		return undefined;
	}

	#startString(): void {
		const frame = this.#stack.at(-1);
		// A missing comma is tolerated: `{"a": 1 "b": 2}` reads the second member.
		if (
			frame !== undefined &&
			!Array.isArray(frame.container) &&
			(frame.phase === "key" || frame.phase === "comma")
		) {
			this.#string = { target: "key", slot: undefined, text: "", escape: "" };
			return;
		}
		const slot = this.#valueSlot();
		this.#string = { target: "value", slot, text: "", escape: "" };
		this.#place(slot, "");
	}

	/** Continue an escape with `char`; returns false when `char` is not part of it and must be read normally. */
	#continueEscape(open: OpenString, char: string): boolean {
		if (open.escape === "\\") {
			const decoded = SIMPLE_ESCAPES[char];
			if (decoded !== undefined) {
				open.escape = "";
				this.#appendString(open, decoded);
				return true;
			}
			if (char === "u") {
				open.escape = "\\u";
				return true;
			}
			// Invalid escape: keep the backslash as text and read the character normally.
			open.escape = "";
			this.#appendString(open, "\\");
			return false;
		}
		if (isHexDigit(char)) {
			open.escape += char;
			if (open.escape.length < 6) return true;
			const decoded = String.fromCharCode(Number.parseInt(open.escape.slice(2), 16));
			open.escape = "";
			this.#appendString(open, decoded);
			return true;
		}
		// `\u` without four hex digits: keep it as text and read the character normally.
		const literal = open.escape;
		open.escape = "";
		this.#appendString(open, literal);
		return false;
	}

	#appendString(open: OpenString, text: string): void {
		open.text += text;
		if (open.target === "value") this.#place(open.slot, open.text);
	}

	#endString(open: OpenString): void {
		this.#string = undefined;
		const frame = this.#stack.at(-1);
		if (open.target === "key") {
			if (frame === undefined) return;
			frame.key = open.text;
			frame.phase = "colon";
			return;
		}
		this.#valueEnded(frame);
	}

	#endScalar(): void {
		const token = this.#scalar;
		const slot = this.#scalarSlot;
		this.#scalar = "";
		this.#scalarSlot = undefined;
		const value = scalarValue(token);
		if (value !== undefined) this.#place(slot, value);
		this.#valueEnded(this.#stack.at(-1));
	}

	/** The value of the unterminated scalar at the end of the text, if it shows. */
	#pendingScalar(): { readonly slot: Slot; readonly value: JsonValue } | undefined {
		const slot = this.#scalarSlot;
		const token = this.#scalar;
		if (slot === undefined || token === "" || token.length > MAX_PENDING_SCALAR_LENGTH) return undefined;
		const value = pendingScalarValue(token);
		return value === undefined ? undefined : { slot, value };
	}

	#openContainer(container: JsonContainer): void {
		const slot = this.#valueSlot();
		this.#place(slot, container);
		this.#stack.push({
			container,
			slot,
			size: 0,
			key: undefined,
			phase: Array.isArray(container) ? "value" : "key",
		});
		this.#pathCost += 1;
		this.#dirty = true;
	}

	#closeContainer(): void {
		const frame = this.#stack.pop();
		// A stray closer outside any container is ignored.
		if (frame === undefined) return;
		this.#pathCost -= frame.size + 1;
		this.#dirty = true;
		this.#valueEnded(this.#stack.at(-1));
	}

	/** A value in `frame`, or the root value when there is no frame, has ended. */
	#valueEnded(frame: Frame | undefined): void {
		if (frame === undefined) {
			// Text after the root value is ignored, but only once a root value exists.
			if (this.#root !== undefined) this.#done = true;
			return;
		}
		frame.phase = "comma";
	}

	/** Set the value at `slot` in the open path; nothing for a value in an invalid position. */
	#place(slot: Slot | undefined, value: JsonValue): void {
		if (slot === undefined) return;
		this.#dirty = true;
		if (slot.kind === "root") {
			this.#root = value;
			return;
		}
		const frame = this.#stack.at(-1)!;
		if (slot.kind === "element") {
			const elements = frame.container as JsonValue[];
			if (slot.index === elements.length) {
				frame.size++;
				this.#pathCost++;
			}
			elements[slot.index] = value;
			return;
		}
		const members = frame.container as { [key: string]: JsonValue };
		if (!Object.hasOwn(members, slot.key)) {
			frame.size++;
			this.#pathCost++;
		}
		setMember(members, slot.key, value);
	}

	/** A fresh snapshot: copies of the open containers, innermost first, each holding the copy of its open child. */
	#copyOpenPath(pending: { readonly slot: Slot; readonly value: JsonValue } | undefined): JsonValue | undefined {
		if (this.#stack.length === 0) return pending?.slot.kind === "root" ? pending.value : this.#root;
		let child: JsonValue | undefined;
		let childSlot: Slot | undefined;
		for (let depth = this.#stack.length - 1; depth >= 0; depth--) {
			const frame = this.#stack[depth]!;
			const copy: JsonContainer = Array.isArray(frame.container) ? frame.container.slice() : { ...frame.container };
			if (depth === this.#stack.length - 1 && pending !== undefined) setSlot(copy, pending.slot, pending.value);
			if (child !== undefined && childSlot !== undefined) setSlot(copy, childSlot, child);
			child = copy;
			childSlot = frame.slot;
		}
		// The outermost open container is the root unless it sits in an invalid position.
		return childSlot?.kind === "root" ? child : this.#root;
	}
}

/**
 * Partial arguments of one streaming tool call. Kept in the stream's own state, never on the content block, so the
 * raw text never reaches partial messages; the final arguments come parsed with the provider's `tool-call` event.
 */
export class ToolCallArgumentsStream {
	readonly #parser = new StreamingJsonParser();
	#snapshot: JsonValue | undefined = undefined;
	#arguments: Record<string, unknown> = {};

	/** Append a piece of argument text; returns the partial arguments, a new object whenever they changed. */
	append(delta: string): Record<string, unknown> {
		this.#parser.append(delta);
		const snapshot = this.#parser.snapshot();
		if (snapshot === this.#snapshot) return this.#arguments;
		this.#snapshot = snapshot;
		// Tool arguments are an object; any other partial value shows as no arguments yet.
		this.#arguments = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? snapshot : {};
		return this.#arguments;
	}
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

function isDelimiter(char: string): boolean {
	return (
		char === " " ||
		char === "\t" ||
		char === "\n" ||
		char === "\r" ||
		char === "," ||
		char === ":" ||
		char === "{" ||
		char === "}" ||
		char === "[" ||
		char === "]" ||
		char === '"'
	);
}

function isHexDigit(char: string): boolean {
	return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

/** The value of a complete number or literal token; `undefined` for anything else, which is dropped. */
function scalarValue(token: string): JsonValue | undefined {
	for (const [literal, value] of LITERALS) if (token === literal) return value;
	return NUMBER.test(token) ? Number(token) : undefined;
}

/** The value an unterminated number or literal token shows. */
function pendingScalarValue(token: string): JsonValue | undefined {
	for (const [literal, value] of LITERALS) if (literal.startsWith(token)) return value;
	if (NUMBER.test(token)) return Number(token);
	const mantissa = NUMBER_WITHOUT_EXPONENT_DIGITS.exec(token);
	return mantissa === null ? undefined : Number(mantissa[1]);
}

function setSlot(container: JsonContainer, slot: Slot, value: JsonValue): void {
	if (slot.kind === "element") (container as JsonValue[])[slot.index] = value;
	else if (slot.kind === "member") setMember(container as { [key: string]: JsonValue }, slot.key, value);
}

function setMember(members: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
	// `__proto__` must become an own member, as in JSON.parse(), not the prototype.
	if (key === "__proto__") {
		Object.defineProperty(members, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		members[key] = value;
	}
}
