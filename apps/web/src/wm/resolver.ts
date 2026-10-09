import type { Priority, Widget } from "../sdk";

const bands: readonly Priority[] = ["extension", "builtin", "fallback"];

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const globs = new Map<string, RegExp>();

function matches(glob: string, address: string) {
	let pattern = globs.get(glob);
	if (pattern === undefined) {
		const source = glob
			.split("**")
			.map((part) => part.split("*").map(escape).join("[^/]*"))
			.join(".*");
		pattern = new RegExp(`^${source}$`);
		globs.set(glob, pattern);
	}
	return pattern.test(address);
}

/**
 * Picks the widget that opens an address: matching globs, then priority band,
 * then the longest matching glob, then registration order. `canOpen` vetoes a
 * candidate; naming a `kind` skips the globs but keeps the veto.
 */
export function resolve(widgets: readonly Widget[], address: string, kind?: string): Widget | undefined {
	const allowed = (widget: Widget) => widget.canOpen?.(address) ?? true;
	if (kind !== undefined) {
		const widget = widgets.find((candidate) => candidate.kind === kind);
		return widget !== undefined && allowed(widget) ? widget : undefined;
	}
	const ranked = widgets.flatMap((widget, index) => {
		const specificity = Math.max(
			-1,
			...(widget.opens ?? []).filter((glob) => matches(glob, address)).map((glob) => glob.length),
		);
		if (specificity < 0 || !allowed(widget)) return [];
		return [{ widget, band: bands.indexOf(widget.priority ?? "extension"), specificity, index }];
	});
	ranked.sort((a, b) => a.band - b.band || b.specificity - a.specificity || a.index - b.index);
	return ranked[0]?.widget;
}
