import { type ComponentProps, createElement, type JSX, memo, useMemo } from "react";
import type { Components, ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { incrementalMarkdown } from "./incremental";

/** An element with fixed classes; react-markdown's `node` prop is dropped so it never reaches the DOM. */
function styled<Tag extends keyof JSX.IntrinsicElements>(tag: Tag, className: string) {
	return (props: ComponentProps<Tag> & ExtraProps) => {
		const rest: Record<string, unknown> = { ...props };
		delete rest.node;
		return createElement(tag, { ...rest, className });
	};
}

const Pre = styled(
	"pre",
	"my-2 overflow-x-auto rounded-lg border border-edge bg-desktop/60 px-3 py-2 font-mono text-[12px] leading-relaxed [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0",
);
const Table = styled("table", "border-collapse text-[13px]");

// GitHub-flavoured markdown at reading size; inline code reads as a small chip, blocks scroll sideways.
const components: Components = {
	p: styled("p", "my-2 first:mt-0 last:mb-0"),
	ul: styled("ul", "my-2 list-disc pl-5"),
	ol: styled("ol", "my-2 list-decimal pl-5"),
	li: styled("li", "my-0.5"),
	h1: styled("h1", "mt-4 mb-2 text-[17px] font-semibold"),
	h2: styled("h2", "mt-4 mb-2 text-[15px] font-semibold"),
	h3: styled("h3", "mt-3 mb-1.5 font-semibold"),
	strong: styled("strong", "font-semibold text-ink"),
	blockquote: styled("blockquote", "my-2 border-l-2 border-edge pl-3 text-ink-muted"),
	pre: Pre,
	code: styled("code", "rounded-md border border-edge bg-ink/5 px-1.5 py-px font-mono text-[12px] text-ink"),
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
