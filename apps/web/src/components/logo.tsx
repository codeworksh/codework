import { cn } from "@/lib/utils";

/** The pixel C and square dot from the site's brand/logo.svg. */
export function Logo({ className }: { readonly className?: string }) {
	return (
		<svg
			viewBox="0 0 10 10"
			fill="currentColor"
			shapeRendering="crispEdges"
			className={cn("size-3.5 shrink-0 text-ink", className)}
			aria-hidden
		>
			<path d="M0 0h10v2H2v6h8v2H0Z" />
			<rect x="8" y="4" width="2" height="2" />
		</svg>
	);
}
