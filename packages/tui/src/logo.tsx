import { Box, Text } from "ink";

const GRADIENT = ["#ec4899", "#d946ef", "#c084fc", "#a855f7", "#818cf8", "#6366f1", "#38bdf8", "#06b6d4", "#22d3ee"];

const LOGO_LINES = [
	"▄██████▄  ▄██   ▄██▄",
	"██▀       ███   ████",
	"██        ███ █ ████",
	"██▄       ██████████",
	"▀██████▀   ▀█▀   ▀█▀",
];

export function Logo() {
	return (
		<Box flexDirection="column" alignItems="center">
			{LOGO_LINES.map((line, rowIndex) => (
				<Box key={rowIndex} flexDirection="row">
					{line.split("").map((char, colIndex) => {
						const colorIndex = Math.min(
							Math.floor((colIndex / line.length) * GRADIENT.length),
							GRADIENT.length - 1,
						);
						const color = GRADIENT[colorIndex] ?? "#38bdf8";
						return (
							<Text key={colIndex} color={color}>
								{char}
							</Text>
						);
					})}
				</Box>
			))}
		</Box>
	);
}
