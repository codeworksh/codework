import { structure, type StructuredData } from "fumadocs-core/mdx-plugins";
import { loader, type StaticSource } from "fumadocs-core/source";
import { type CollectionEntry, getCollection } from "astro:content";
import * as path from "node:path";

type Source = StaticSource<{
	metaData: CollectionEntry<"meta">["data"];
	pageData: CollectionEntry<"docs">["data"] & { _raw: CollectionEntry<"docs"> };
}>;

async function collect(): Promise<Source> {
	const files: Source["files"] = [];
	for (const page of await getCollection("docs")) {
		files.push({
			type: "page",
			path: path.relative("content/docs", page.filePath!),
			data: { ...page.data, title: page.data.sidebarTitle ?? page.data.title, _raw: page },
		});
	}
	for (const meta of await getCollection("meta")) {
		files.push({ type: "meta", path: path.relative("content/docs", meta.filePath!), data: meta.data });
	}
	return { files };
}

export const source = loader({ source: await collect(), baseUrl: "/docs" });

export function getStructuredData(entry: CollectionEntry<"docs">): StructuredData {
	return structure(entry.body ?? "");
}
