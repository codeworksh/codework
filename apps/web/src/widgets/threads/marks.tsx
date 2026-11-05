import type { Priority, ThreadStatus } from "@codeworksh/contract";

export const STATUS: Record<ThreadStatus, { readonly label: string; readonly color: string }> = {
	working: { label: "Working", color: "#f0bf00" },
	attention: { label: "Needs Attention", color: "#f2994a" },
	settled: { label: "Settled", color: "#5e6ad2" },
	cancelled: { label: "Cancelled", color: "#95a2b3" },
};
/** In the order the server lists them: what needs the user first. */
export const STATUSES: ReadonlyArray<ThreadStatus> = ["working", "attention", "settled", "cancelled"];

export const PRIORITY: Record<Priority, { readonly label: string }> = {
	1: { label: "Urgent" },
	2: { label: "High" },
	3: { label: "Medium" },
	4: { label: "Low" },
	0: { label: "No Priority" },
};
export const PRIORITIES: ReadonlyArray<Priority> = [1, 2, 3, 4, 0];

/** The colors a group or thread can take, Linear's label hues. */
export const COLORS: ReadonlyArray<{ readonly name: string; readonly hex: string }> = [
	{ name: "Red", hex: "#e5484d" },
	{ name: "Orange", hex: "#f76b15" },
	{ name: "Yellow", hex: "#ffc53d" },
	{ name: "Green", hex: "#46a758" },
	{ name: "Teal", hex: "#12a594" },
	{ name: "Blue", hex: "#0090ff" },
	{ name: "Purple", hex: "#8e4ec6" },
	{ name: "Pink", hex: "#d6409f" },
	{ name: "Gray", hex: "#8b8d98" },
];

/** A color's name, or the hex of one not in `COLORS`. */
export const colorName = (hex: string) => COLORS.find((color) => color.hex === hex)?.name ?? hex;

/** A status as Linear draws one: a ring, half full while working, filled with a mark once done. */
export function StatusIcon({ status }: { readonly status: ThreadStatus }) {
	const { color } = STATUS[status];
	return (
		<svg viewBox="0 0 14 14" className="size-3.5 shrink-0" aria-hidden>
			{status === "working" && (
				<>
					<circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="1.5" />
					<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={color} />
				</>
			)}
			{status === "attention" && (
				<>
					<circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="1.5" />
					<path d="M7 4v3.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
					<circle cx="7" cy="9.75" r="0.85" fill={color} />
				</>
			)}
			{status === "settled" && (
				<>
					<circle cx="7" cy="7" r="6.5" fill={color} />
					<path
						d="M4.5 7.2l1.7 1.7 3.4-3.6"
						fill="none"
						stroke="var(--color-frame)"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</>
			)}
			{status === "cancelled" && (
				<>
					<circle cx="7" cy="7" r="6.5" fill={color} />
					<path d="M5 5l4 4M9 5l-4 4" stroke="var(--color-frame)" strokeWidth="1.5" strokeLinecap="round" />
				</>
			)}
		</svg>
	);
}

/** A priority as Linear draws one: three dots for none, a filled box for urgent, else bars. */
export function PriorityIcon({ priority }: { readonly priority: Priority }) {
	if (priority === 0)
		return (
			<svg viewBox="0 0 14 14" className="size-3.5 shrink-0 text-ink-muted" aria-hidden>
				{[3, 7, 11].map((x) => (
					<circle key={x} cx={x} cy="7" r="1" fill="currentColor" />
				))}
			</svg>
		);
	if (priority === 1)
		return (
			<svg viewBox="0 0 14 14" className="size-3.5 shrink-0" aria-hidden>
				<rect x="1" y="1" width="12" height="12" rx="3" fill="var(--color-warning)" />
				<path d="M7 3.75v4" stroke="var(--color-frame)" strokeWidth="1.6" strokeLinecap="round" />
				<circle cx="7" cy="10" r="0.9" fill="var(--color-frame)" />
			</svg>
		);
	const filled = 5 - priority;
	return (
		<svg viewBox="0 0 14 14" className="size-3.5 shrink-0 text-ink-secondary" aria-hidden>
			{[0, 1, 2].map((bar) => (
				<rect
					key={bar}
					x={1.5 + bar * 4}
					y={8 - bar * 3}
					width="3"
					height={5 + bar * 3}
					rx="1"
					fill="currentColor"
					opacity={bar < filled ? 1 : 0.3}
				/>
			))}
		</svg>
	);
}

export function Dot({ color }: { readonly color: string | null }) {
	return (
		<span
			aria-hidden
			className="size-2.5 shrink-0 rounded-full border border-ink/20"
			style={color === null ? undefined : { backgroundColor: color, borderColor: color }}
		/>
	);
}

/** A machine as an assignee-like avatar: its initial on a hue of its id. */
export function MachineAvatar({ name, id }: { readonly name: string; readonly id: string }) {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return (
		<span
			role="img"
			aria-label={`Machine: ${name}`}
			title={name}
			className="grid size-4.5 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white uppercase"
			style={{ backgroundColor: `oklch(0.6 0.12 ${Math.abs(hash) % 360})` }}
		>
			{name.slice(0, 1)}
		</span>
	);
}

/** Linear's short date: "Nov 5", with the year once it is not this one. */
export const shortDate = (time: number) => {
	const date = new Date(time);
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
	});
};
