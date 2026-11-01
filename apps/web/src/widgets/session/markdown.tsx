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
import type { Components, ExtraProps, Options } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { themeAtom } from "../../theme";
import { HighlightedCode, languageOf, useHighlight } from "./highlight";
import { incrementalMarkdown, splitMarkdownBlocks } from "./incremental";

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
			className="grid size-6 place-items-center rounded-md text-ink-muted hover:bg-ink/10 hover:text-ink press"
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
		<div className="my-4 overflow-hidden rounded-lg border border-ink/10 bg-muted first:mt-0 last:mb-0">
			<div className="flex min-h-9 items-center justify-between border-b border-ink/10 pr-2 pl-3 font-mono text-xs font-medium text-ink-muted select-none">
				<span className="truncate lowercase">{block.language ?? "text"}</span>
				<CopyButton text={block.code} />
			</div>
			<pre className={preClass}>
				{highlighted === undefined ? <code>{block.code}</code> : <HighlightedCode root={highlighted} />}
			</pre>
		</div>
	);
}

const preClass = "overflow-x-auto px-3 py-2.5 font-mono text-xs leading-5 text-ink";
const Table = styled("table", "w-full border-collapse text-xs");

// GitHub-flavoured markdown at reading size.
const components: Components = {
	p: styled("p", "my-3 first:mt-0 last:mb-0"),
	ul: styled("ul", "my-2 list-disc pl-6"),
	ol: styled("ol", "my-2 list-decimal pl-6"),
	li: styled("li", "my-0.5"),
	h1: styled("h1", "mt-5 mb-2 text-xl font-semibold tracking-tight text-ink first:mt-0"),
	h2: styled("h2", "mt-4 mb-2 text-lg font-semibold tracking-tight text-ink first:mt-0"),
	h3: styled("h3", "mt-3 mb-1.5 text-2xs font-semibold tracking-wider text-ink uppercase first:mt-0"),
	strong: styled("strong", "font-semibold text-ink"),
	blockquote: styled("blockquote", "my-3 border-l-4 border-ink/20 pl-4 text-ink-muted"),
	hr: styled("hr", "my-5 border-0 border-t border-ink/10"),
	pre: CodeBlock,
	// Inline code reads as a small chip; inside a fence the block renders the text itself.
	code: styled("code", "rounded-sm bg-ink/8 px-1.5 py-0.5 font-mono text-xs text-ink"),
	th: styled("th", "border-b border-ink/10 px-2.5 py-2 text-left font-semibold text-ink"),
	td: styled("td", "border-t border-ink/5 px-2.5 py-2 align-top"),
	a: (props) => {
		const rest: Record<string, unknown> = { ...props };
		delete rest.node;
		return createElement("a", {
			...rest,
			className: "text-link hover:underline",
			target: "_blank",
			rel: "noreferrer",
		});
	},
	table: (props) => (
		<div className="my-4 overflow-x-auto rounded-lg border border-ink/10 bg-muted first:mt-0 last:mb-0">
			<Table {...props} />
		</div>
	),
};

const plugins = [remarkGfm];

// One finished block of a streaming reply: it keeps its render while later blocks grow.
const Block = memo(function Block({
	source,
	remarkPlugins = plugins,
}: {
	readonly source: string;
	readonly remarkPlugins?: Options["remarkPlugins"];
}) {
	return (
		<ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
			{source}
		</ReactMarkdown>
	);
});

/**
 * A message's markdown, rendered as text: raw HTML in it stays escaped. It re-renders only when its
 * text changes. While a reply streams, it renders block by block, so only the growing block is
 * parsed again on each delta; text that can't be split but has code fences parses incrementally.
 */
export const Markdown = memo(function Markdown({
	text,
	streaming = false,
	className,
}: {
	readonly text: string;
	readonly streaming?: boolean;
	readonly className?: string;
}) {
	const incremental = useMemo(() => incrementalMarkdown(), []);
	const blocks = streaming ? splitMarkdownBlocks(text) : null;
	const fenced = streaming && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
	const remarkPlugins = useMemo(() => (fenced ? [remarkGfm, incremental] : plugins), [fenced, incremental]);
	return (
		<div className={`agent-markdown min-w-0 ${className ?? ""}`}>
			{/* react-markdown renders a Fragment, so the blocks' elements sit in this div as one document's would.
			    Whole text stays block 0, so a finished reply reuses its first block rather than remounting. */}
			{blocks === null ? (
				<Block key={0} source={text} remarkPlugins={remarkPlugins} />
			) : (
				blocks.map((source, index) => <Block key={index} source={source} />)
			)}
		</div>
	);
});
