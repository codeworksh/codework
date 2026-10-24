import { useAtomValue } from "@effect/atom-react";
import { Check, Copy } from "lucide-react";
import {
	type ComponentProps,
	createElement,
	isValidElement,
	type JSX,
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { themeAtom } from "../../theme";
import { HighlightedCode, languageOf, useHighlight } from "./highlight";
import { incrementalMarkdown } from "./incremental";

/** An element with fixed classes; react-markdown's `node` prop is dropped so it never reaches the DOM. */
function styled<Tag extends keyof JSX.IntrinsicElements>(tag: Tag, className: string) {
	return (props: ComponentProps<Tag> & ExtraProps) => {
		const rest: Record<string, unknown> = { ...props };
		delete rest.node;
		return createElement(tag, { ...rest, className });
	};
}

/** A fenced block's language and text, from the `code` element react-markdown puts in a `pre`. */
function fence(children: ReactNode) {
	if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return undefined;
	const { className = "", children: text } = children.props;
	if (typeof text !== "string") return undefined;
	// The fence's trailing newline would render as an empty last line.
	return { language: /language-(\S+)/.exec(className)?.[1], code: text.replace(/\n$/, "") };
}

function CopyButton({ text }: { readonly text: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1200);
		return () => clearTimeout(timer);
	}, [copied]);
	const Icon = copied ? Check : Copy;
	return (
		<button
			type="button"
			aria-label={copied ? "Copied" : "Copy code"}
			title="Copy code"
			className="press grid size-6 place-items-center rounded-md text-ink-muted hover:bg-ink/8 hover:text-ink"
			onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
		>
			<Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
		</button>
	);
}

/** A fenced code block: its language and a copy button above the code, highlighted for the palette. */
function CodeBlock(props: ComponentProps<"pre"> & ExtraProps) {
	const block = fence(props.children);
	const theme = useAtomValue(themeAtom);
	const language = languageOf(block?.language);
	const highlighted = useHighlight(block?.code ?? "", language, theme);
	if (block === undefined) return <pre className={preClass}>{props.children}</pre>;
	return (
		<div className="my-2 overflow-hidden rounded-lg border border-edge bg-desktop/60">
			<div className="flex h-7 items-center justify-between border-b border-edge pr-1 pl-3 text-2xs text-ink-muted select-none">
				<span>{block.language ?? "text"}</span>
				<CopyButton text={block.code} />
			</div>
			<pre className={preClass}>
				{highlighted === undefined ? <code>{block.code}</code> : <HighlightedCode root={highlighted} />}
			</pre>
		</div>
	);
}

const preClass = "overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed";
const Table = styled("table", "border-collapse text-sm");

// GitHub-flavoured markdown at reading size.
const components: Components = {
	p: styled("p", "my-2 first:mt-0 last:mb-0"),
	ul: styled("ul", "my-2 list-disc pl-5"),
	ol: styled("ol", "my-2 list-decimal pl-5"),
	li: styled("li", "my-0.5"),
	h1: styled("h1", "mt-4 mb-2 text-[17px] font-semibold"),
	h2: styled("h2", "mt-4 mb-2 text-base font-semibold"),
	h3: styled("h3", "mt-3 mb-1.5 font-semibold"),
	strong: styled("strong", "font-semibold text-ink"),
	blockquote: styled("blockquote", "my-2 border-l-2 border-edge pl-3 text-ink-muted"),
	pre: CodeBlock,
	// Inline code reads as a small chip; inside a fence the block renders the text itself.
	code: styled("code", "rounded-md border border-edge bg-ink/5 px-1.5 py-px font-mono text-xs text-ink"),
	th: styled("th", "border border-edge px-2 py-1 text-left font-semibold"),
	td: styled("td", "border border-edge px-2 py-1"),
	a: (props) => {
		const rest: Record<string, unknown> = { ...props };
		delete rest.node;
		return createElement("a", {
			...rest,
			className: "text-brand underline underline-offset-2",
			target: "_blank",
			rel: "noreferrer",
		});
	},
	table: (props) => (
		<div className="my-2 overflow-x-auto">
			<Table {...props} />
		</div>
	),
};

const plugins = [remarkGfm];

/**
 * A message's markdown, rendered as text: raw HTML in it stays escaped. It re-renders only when its
 * text changes. While a reply streams, text with code fences parses incrementally, so a long code
 * block is not parsed again on every delta.
 */
export const Markdown = memo(function Markdown({
	text,
	streaming = false,
}: {
	readonly text: string;
	readonly streaming?: boolean;
}) {
	const incremental = useMemo(() => incrementalMarkdown(), []);
	const fenced = streaming && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
	const remarkPlugins = useMemo(() => (fenced ? [remarkGfm, incremental] : plugins), [fenced, incremental]);
	return (
		<ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
			{text}
		</ReactMarkdown>
	);
});
