import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Loader } from "astro/loaders";
import { GITHUB_URL } from "../components/landing/content";

/** The repo's hand-written CHANGELOG.md is the single source; the site never keeps its own copy. */
const FILE = resolve("../../CHANGELOG.md");

/** `## [@codeworksh/aikit@0.10.0]`, optionally followed by ` - 2026-10-07`. */
const HEADING = /^## \[(.+?)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/gm;

export function changelogLoader(): Loader {
	return {
		name: "changelog",
		async load(context) {
			const { store, watcher } = context;
			async function sync() {
				const text = await readFile(FILE, "utf8");
				const headings = [...text.matchAll(HEADING)];
				store.clear();
				for (const [i, match] of headings.entries()) {
					const [heading, label, date] = match;
					if (label === "Unreleased") continue;
					const start = match.index + heading.length;
					// Links in CHANGELOG.md are relative to the repo root, which only resolves on GitHub.
					const body = text
						.slice(start, headings[i + 1]?.index ?? text.length)
						.trim()
						.replaceAll("](./", `](${GITHUB_URL}/blob/main/`);
					// "@codeworksh/aikit@0.10.0" → package "aikit", version "0.10.0"; "Setup" has neither.
					const release = /^@codeworksh\/(.+)@(.+)$/.exec(label!);
					const id = release ? `${release[1]}-${release[2]}` : label!.toLowerCase();
					store.set({
						id,
						data: {
							title: release ? `${release[1]} ${release[2]}` : label!,
							pkg: release?.[1],
							date,
							order: i,
						},
						body,
						rendered: scopeHeadings(await context.renderMarkdown(body), id),
					});
				}
			}
			await sync();
			watcher?.add(FILE);
			watcher?.on("change", (path) => path === FILE && sync());
		},
	};
}

type Rendered = Awaited<ReturnType<Parameters<Loader["load"]>[0]["renderMarkdown"]>>;

/** Every release has its own "Added", "Fixed"…; prefixing keeps their ids unique on a page. */
function scopeHeadings(rendered: Rendered, prefix: string): Rendered {
	return { ...rendered, html: rendered.html.replace(/<(h[1-6]) id="/g, `<$1 id="${prefix}-`) };
}
