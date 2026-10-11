import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";
import { changelogLoader } from "./lib/changelog";

const docs = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./content/docs" }),
	schema: z.object({
		title: z.string(),
		/** Shorter label for the sidebar and search when the page title is too long for them. */
		sidebarTitle: z.string().optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
	}),
});

const meta = defineCollection({
	loader: glob({ pattern: "**/*.{json,yaml}", base: "./content/docs" }),
	schema: z.object({
		title: z.string().optional(),
		description: z.string().optional(),
		pages: z.array(z.string()).optional(),
		icon: z.string().optional(),
	}),
});

const posts = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./content/posts" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		updated: z.coerce.date().optional(),
		tag: z.enum(["announcement", "release", "tutorial", "note"]),
		/** One line for the landing hero; the newest post that has one is featured there. */
		callout: z.string().optional(),
	}),
});

const changelog = defineCollection({
	loader: changelogLoader(),
	schema: z.object({
		title: z.string(),
		pkg: z.string().optional(),
		date: z.coerce.date().optional(),
		/** Position in CHANGELOG.md, which lists newest first. */
		order: z.number(),
	}),
});

export const collections = { docs, meta, posts, changelog };
