import type { AstroProviderProps } from "fumadocs-core/framework/astro";
import type { Root } from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsPage, type DocsPageProps } from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/astro";
import type { ReactNode } from "react";
import { navigate } from "astro:transitions/client";
import Search from "./search";

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
			<DocsLayout tree={props.tree} themeSwitch={{ enabled: false }} nav={{ title: "CodeWork" }}>
				<DocsPage {...props.page}>{props.children}</DocsPage>
			</DocsLayout>
		</RootProvider>
	);
}
