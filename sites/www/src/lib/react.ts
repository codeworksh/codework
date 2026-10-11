import defaultMdxComponents from "fumadocs-ui/mdx";
import { Docs } from "@/components/docs";
import { Field } from "@/components/landing/field";
import { GithubIcon } from "@/components/landing/github";
import { Header } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { Picker } from "@/components/landing/picker";
import { Pixels } from "@/components/landing/pixels";
import { Scene } from "@/components/landing/scene";
import { Typewriter } from "@/components/landing/typewriter";
import { Videos } from "@/components/landing/videos";
import { Placeholder } from "@/components/placeholder";

/**
 * Astro probes renderers in turn to find one for a component. If React's probe rejects one, the MDX probe runs last and
 * calls it as a plain function outside React, which logs "Invalid hook call" in dev. Tagging skips the probing.
 */
const tag = Symbol.for("astro:renderer");
for (const component of [
	Docs,
	Field,
	GithubIcon,
	Header,
	Hero,
	Picker,
	Pixels,
	Scene,
	Typewriter,
	Videos,
	Placeholder,
	...Object.values(defaultMdxComponents),
]) {
	if (typeof component === "function") Object.assign(component, { [tag]: "@astrojs/react" });
}
