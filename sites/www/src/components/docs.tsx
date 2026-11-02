import type { AstroProviderProps } from "fumadocs-core/framework/astro";
import type { Root } from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsPage, type DocsPageProps } from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { navigate } from "astro:transitions/client";
import Search from "./search";
import { Logo } from "./landing/logo";

export function Docs(props: {
	tree: Root;
	children: ReactNode;
	pathname: string;
	params: AstroProviderProps["params"];
	page?: DocsPageProps;
}) {
	return (
		<RootProvider
			pathname={props.pathname}
			params={props.params}
			navigate={navigate}
			theme={{ enabled: false }}
			search={{ SearchDialog: Search }}
		>
			<DocsLayout
				tree={props.tree}
				themeSwitch={{ enabled: false }}
				nav={{
					title: (
						<>
							<Logo className="mr-2 size-5" />
							CodeWork
						</>
					),
				}}
			>
				<DocsPage
					{...props.page}
					tableOfContent={{ ...props.page?.tableOfContent, footer: <CopyPage pathname={props.pathname} /> }}
				>
					{props.children}
				</DocsPage>
			</DocsLayout>
		</RootProvider>
	);
}

/** The page's markdown, from the `.md` route beside it; the welcome page is `/docs/index.md`. */
const markdownUrl = (pathname: string) => {
	const path = pathname.replace(/\/$/, "");
	return path === "/docs" ? "/docs/index.md" : `${path}.md`;
};

function CopyPage({ pathname }: { pathname: string }) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		const url = markdownUrl(pathname);
		try {
			await navigator.clipboard.writeText(await fetch(url).then((response) => response.text()));
		} catch {
			// Where the clipboard is blocked, the markdown itself is the next best thing.
			window.open(url, "_blank", "noopener");
			return;
		}
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<button
			type="button"
			onClick={copy}
			className="mt-4 inline-flex items-center gap-1.5 border-t border-fd-border pt-4 text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground [&_svg]:size-3.5"
		>
			{copied ? <Check className="text-fd-primary" /> : <Copy />}
			{copied ? "Copied" : "Copy page"}
		</button>
	);
}
