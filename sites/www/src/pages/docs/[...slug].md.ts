import type { APIRoute } from "astro";
import type { CollectionEntry } from "astro:content";
import { source } from "@/lib/source";

/** Every docs page as markdown at its own URL plus `.md`, for "Copy page" and for agents reading the docs. */
export function getStaticPaths() {
	return source.getPages().map((page) => ({
		// The welcome page has no slug of its own, so it is served as `/docs/index.md`.
		params: { slug: page.slugs.length > 0 ? page.slugs.join("/") : "index" },
		props: { page: page.data._raw },
	}));
}

export const GET: APIRoute<{ page: CollectionEntry<"docs"> }> = ({ props: { page } }) => {
	const lede = page.data.description ? `\n\n${page.data.description}` : "";
	return new Response(`# ${page.data.title}${lede}\n\n${(page.body ?? "").trim()}\n`, {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
};
