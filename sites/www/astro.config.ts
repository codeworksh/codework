import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { rehypeCode, remarkHeading, remarkStructure } from "fumadocs-core/mdx-plugins";

export default defineConfig({
	site: "https://codework.sh",
	// Pages moved when the docs were regrouped by feature; old links keep working.
	redirects: {
		"/docs/cli/acp": "/docs/integrations/acp",
		"/docs/cli/rpc": "/docs/integrations/rpc",
		"/docs/cli/settings": "/docs/customize/settings",
		"/docs/cli/using": "/docs/agent/tools",
	},
	markdown: {
		syntaxHighlight: false,
		processor: unified({
			remarkPlugins: [remarkHeading, [remarkStructure, { exportAs: "structuredData" }]],
			// Fumadocs sets its own tabIndex on code blocks; Shiki's lowercase one duplicates it and trips React.
			rehypePlugins: [[rehypeCode, { tabindex: false }]],
		}),
	},
	integrations: [react(), sitemap(), mdx({ extendMarkdownConfig: true, syntaxHighlight: false })],
	server: {
		// ngrok tunnels to the dev server; a leading dot admits every subdomain.
		allowedHosts: [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.dev", ".ngrok.app", ".ngrok.io"],
	},
	vite: {
		plugins: [tailwindcss()],
	},
});
