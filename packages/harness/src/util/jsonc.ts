import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

/** `line:column`, 1-based, for a parser offset into the source. */
const at = (source: string, offset: number): string => {
	const before = source.slice(0, offset).split("\n");
	return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
};

/**
 * A hand-written config file: comments and a trailing comma are part of the format rather than
 * mistakes. A syntax error is reported once, as the parser's reason at `line:column`.
 */
export const parse = (source: string): { readonly value: unknown } | { readonly error: string } => {
	const errors: ParseError[] = [];
	const value: unknown = parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false });
	const first = errors[0];
	return first === undefined
		? { value }
		: { error: `${printParseErrorCode(first.error)} at ${at(source, first.offset)}` };
};
