import type { LucideIcon } from "lucide-react";
import { Exit, Schema } from "effect";
import { type ComponentType, createElement, type ReactNode } from "react";

/** Everything a widget component receives from the host. */
export interface WidgetProps<Props> {
	/** Stable id of this placed copy; namespaces its saved state. */
	readonly instanceId: string;
	/** This copy's settings, already decoded with the definition's `props` schema. */
	readonly props: Props;
}

/** What a widget author declares. */
export interface WidgetDefinition<Props> {
	/** Unique id of the widget type, e.g. "explorer". Namespaces its storage. */
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
export interface Widget {
	readonly kind: string;
	readonly title: string;
	readonly icon: LucideIcon;
	readonly minWidth: number;
	readonly minHeight: number;
	readonly cardinality: "one" | "many";
	render(instance: { readonly instanceId: string; readonly props: unknown }): ReactNode;
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
		render({ instanceId, props }) {
			const decoded = decode(props);
			if (Exit.isFailure(decoded)) {
				return <p className="p-3 text-ink-muted">Invalid settings for {definition.kind}.</p>;
			}
			return createElement(component, { instanceId, props: decoded.value });
		},
	};
}
