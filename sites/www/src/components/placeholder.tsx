import { Image, Video } from "lucide-react";
import type { ReactNode } from "react";

/** Stands in for a screenshot or video that hasn't been captured yet. `children` describes the shot. */
export function Placeholder(props: { type?: "image" | "video"; title: string; children?: ReactNode }) {
	const Icon = props.type === "video" ? Video : Image;
	return (
		<figure className="not-prose my-6 flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-fd-border bg-fd-muted p-6 text-center">
			<Icon className="size-6 text-fd-muted-foreground" />
			<figcaption className="font-medium text-fd-foreground">{props.title}</figcaption>
			{props.children && <div className="max-w-md text-sm text-fd-muted-foreground">{props.children}</div>}
		</figure>
	);
}
