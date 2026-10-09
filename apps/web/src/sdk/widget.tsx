import type { LucideIcon } from "lucide-react";
import { Exit, Schema } from "effect";
import { type ComponentType, createElement, type ReactNode } from "react";

/** Everything a widget component receives from the host. */
export interface WidgetProps<Props> {
	/** Stable id of this placed copy; namespaces its saved state. */
	readonly instanceId: string;
	/** This copy's settings, already decoded with the definition's `props` schema. */
	readonly props: Props;
	/** What this copy shows when it was opened by address (e.g. `codework://session/s1`). */
	readonly address: string | undefined;
	/** Navigation parameters from the latest `open` of this address (e.g. a line to reveal). */
	readonly params: Params;
}

export type Params = Readonly<Record<string, unknown>>;

/**
 * Which widget wins when several open an address: an extension beats a
 * builtin, which beats a fallback viewer.
 */
export type Priority = "extension" | "builtin" | "fallback";

/** How a widget takes part in navigation. */
export interface Navigation {
	/**
	 * Address globs this widget can show: `*` matches within one path segment,
	 * `**` across segments. A widget without any is opened by kind only.
	 */
	readonly opens?: readonly string[];
	/** Defaults to "extension". */
	readonly priority?: Priority;
	/** Vetoes an address the globs matched, or one opened by kind. */
	readonly canOpen?: (address: string) => boolean;
	/**
	 * A plain `open` from the widget that opened this one may show another
	 * address in this frame instead of adding a frame (list → detail). Pinned
	 * frames are never replaced.
	 */
	readonly replaceable?: boolean;
}

/** What a widget author declares. */
export interface WidgetDefinition<Props> extends Navigation {
	/** Unique id of the widget type, qualified by its package: "codework:explorer". */
	readonly kind: string;
	/** Default frame title; an instance may override it. */
	readonly title: string;
	readonly icon: LucideIcon;
	/** Smallest usable size in CSS pixels; the layout never goes below it. */
	readonly minWidth: number;
	readonly minHeight: number;
	/** "one" allows a single instance (the shell hides duplicate). */
	readonly cardinality: "one" | "many";
	/** Validates an instance's saved settings before they reach the component. */
	readonly props: Schema.Decoder<Props>;
	readonly component: ComponentType<WidgetProps<Props>>;
}

/** A registered widget as the window manager sees it, with its props type erased. */
export interface Widget extends Navigation {
	readonly kind: string;
	readonly title: string;
	readonly icon: LucideIcon;
	readonly minWidth: number;
	readonly minHeight: number;
	readonly cardinality: "one" | "many";
	render(instance: {
		readonly instanceId: string;
		readonly props: unknown;
		readonly address: string | undefined;
		readonly params: Params;
	}): ReactNode;
}

/**
 * Declares a widget. Built-in and third-party widgets both export the result;
 * the registry only ever holds this erased form, so mixing widgets with
 * different props types needs no casts.
 */
export function defineWidget<Props>(definition: WidgetDefinition<Props>): Widget {
	const { props: schema, component, ...meta } = definition;
	const decode = Schema.decodeUnknownExit(schema);
	return {
		...meta,
		render({ props, ...instance }) {
			const decoded = decode(props);
			if (Exit.isFailure(decoded)) {
				return <p className="p-3 text-ink-muted">Invalid settings for {definition.kind}.</p>;
			}
			return createElement(component, { ...instance, props: decoded.value });
		},
	};
}
