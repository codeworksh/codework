import type { ReactNode } from "react";

import { PixelLoader } from "@/components/loader";
import { type Display, displayLabel } from "./display";

/**
 * A thread's run as an icon: the loader while it starts or runs, dimmed while a prompt or a stop is
 * on its way. Idle draws `idle`, or nothing.
 */
export function RunMark({ display, idle = null }: { readonly display: Display; readonly idle?: ReactNode }) {
	if (display === "idle") return idle;
	return (
		<span
			role="img"
			aria-label={displayLabel[display]}
			title={displayLabel[display]}
			className={`flex shrink-0 ${display === "pending" || display === "stopping" ? "opacity-50" : ""}`}
		>
			<PixelLoader />
		</span>
	);
}
