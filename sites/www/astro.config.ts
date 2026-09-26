import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { rehypeCode, remarkHeading, remarkStructure } from "fumadocs-core/mdx-plugins";

export default defineConfig({
	markdown: {
		syntaxHighlight: false,
		processor: unified({
			remarkPlugins: [remarkHeading, [remarkStructure, { exportAs: "structuredData" }]],
			rehypePlugins: [rehypeCode],
		}),
	},
	integrations: [react(), mdx({ extendMarkdownConfig: true, syntaxHighlight: false })],
	vite: {
		plugins: [tailwindcss()],
	},
});
