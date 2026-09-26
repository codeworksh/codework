import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";

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

export const collections = { docs, meta };
