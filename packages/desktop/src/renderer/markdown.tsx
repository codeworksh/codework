import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

const components = {
	a: ({ href, children }) => (
		<a href={href} target="_blank" rel="noreferrer">
			{children}
		</a>
	),
} satisfies Components;

export const AgentMarkdown = ({ content }: { readonly content: string }) => (
	<div className="chat-markdown max-w-[48rem] text-sm leading-7 text-zinc-200">
		<Markdown remarkPlugins={plugins} components={components}>
			{content}
		</Markdown>
	</div>
);
