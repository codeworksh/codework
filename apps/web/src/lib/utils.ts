import { type ClassValue, clsx } from "clsx";
import { Cause, Option } from "effect";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own type sizes (style.css), so `text-ui` replaces a component's `text-sm`.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["4xs", "3xs", "2xs", "ui", "body", "code"] } } });

/** Joins class names; later Tailwind utilities win over conflicting earlier ones. */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * A failure's message for showing it: the error's own, else the value as text. An Effect cause (an atom's
 * failure) shows its typed error, else what it squashes to.
 */
export const messageOf = (cause: unknown): string => {
	if (Cause.isCause(cause))
		return messageOf(Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause)));
	return typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
		? cause.message
		: String(cause);
};

export const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
