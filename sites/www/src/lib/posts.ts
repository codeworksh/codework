import { type CollectionEntry, getCollection } from "astro:content";

export type Post = CollectionEntry<"posts">;

/** Newest first. */
export async function getPosts(): Promise<Post[]> {
	const posts = await getCollection("posts");
	return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export const postUrl = (post: Post) => `/posts/${post.id}/`;
