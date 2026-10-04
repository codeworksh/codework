import { useEffect, useState } from "react";
import { Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerProps {
	readonly color?: string;
	readonly intervalMs?: number;
}

/**
 * Animated braille terminal spinner for Ink.
 */
export function Spinner({ color = "#06b6d4", intervalMs = 80 }: SpinnerProps) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
		}, intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);

	return <Text color={color}>{SPINNER_FRAMES[frame] ?? "⠋"}</Text>;
}
