import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getPosts, postUrl } from "@/lib/posts";

export async function GET(context: APIContext) {
	return rss({
		title: "CodeWork Posts",
		description: "Announcements, releases, tutorials and technical notes from the CodeWork team.",
		site: context.site!,
		items: (await getPosts()).map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.date,
			link: postUrl(post),
		})),
	});
}
