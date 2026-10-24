import type { CliEnvVar } from "@codeworksh/contract";
import { Lock, LockOpen, Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { quietField } from "../blocks";

interface Row {
	readonly id: number;
	readonly name: string;
	readonly value: string;
	readonly sensitive: boolean;
	/** A sensitive value saved earlier, which the app never gets back: kept unless typed over. */
	readonly kept: boolean;
}

let nextId = 0;
const rowOf = ({ name, value, sensitive }: CliEnvVar): Row => ({
	id: nextId++,
	name,
	value: value ?? "",
	sensitive,
	kept: value === undefined,
});

/** What saving sends: named rows only, and a kept sensitive value as no value, so it stays. */
const toSave = (rows: readonly Row[]): CliEnvVar[] =>
	rows
		.filter((row) => row.name.trim() !== "")
		.map(({ name, value, sensitive, kept }) =>
			kept && value === "" ? { name: name.trim(), sensitive } : { name: name.trim(), sensitive, value },
		);

/**
 * The variables the server starts with, one `NAME = value` row each. A row saves when its field is
 * left, its lock is toggled or it is removed; a new row waits for a name.
 */
export function Variables({
	saved,
	onSave,
}: {
	saved: readonly CliEnvVar[];
	onSave: (env: CliEnvVar[]) => Promise<string | undefined>;
}) {
	const [rows, setRows] = useState<readonly Row[]>(() => saved.map(rowOf));
	const [error, setError] = useState<string | undefined>(undefined);

	const save = (next: readonly Row[]) => {
		const env = toSave(next);
		if (JSON.stringify(env) === JSON.stringify(toSave(saved.map(rowOf)))) return;
		setError(undefined);
		void onSave(env).then(setError);
	};
	const update = (id: number, patch: Partial<Row>) =>
		setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));

	return (
		<div className="flex flex-col gap-2">
			<Button
				size="sm"
				variant="secondary"
				className="self-start"
				onClick={() => setRows((current) => [...current, rowOf({ name: "", value: "", sensitive: false })])}
			>
				<Plus />
				Add variable
			</Button>
			{rows.map((row, index) => (
				<span key={row.id} className="flex items-center gap-2">
					<Input
						aria-label={`Environment variable name ${index + 1}`}
						placeholder="VARIABLE_NAME"
						value={row.name}
						autoFocus={row.name === "" && !row.kept}
						className={`${quietField} w-2/5 font-mono text-xs md:text-xs`}
						onChange={(event) => update(row.id, { name: event.target.value })}
						onBlur={() => save(rows)}
					/>
					<span className="text-ink-muted">=</span>
					<Input
						aria-label={`Environment variable value ${index + 1}`}
						type={row.sensitive ? "password" : "text"}
						placeholder={row.kept ? "Saved; type to replace" : "value"}
						value={row.value}
						className={`${quietField} flex-1 font-mono text-xs md:text-xs`}
						onChange={(event) => update(row.id, { value: event.target.value })}
						onBlur={() => save(rows)}
					/>
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`${row.sensitive ? "Unmark" : "Mark"} environment variable ${index + 1} as sensitive`}
						title={row.sensitive ? "Sensitive: never shown again" : "Mark as sensitive"}
						onClick={() => {
							// Unmarking never reveals a saved secret: a kept value is dropped and typed again.
							const next = rows.map((other) =>
								other.id !== row.id
									? other
									: other.sensitive && other.kept && other.value === ""
										? { ...other, sensitive: false, kept: false }
										: { ...other, sensitive: !other.sensitive },
							);
							setRows(next);
							save(next);
						}}
					>
						{row.sensitive ? <Lock className="text-info" /> : <LockOpen />}
					</Button>
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`Remove environment variable ${index + 1}`}
						title="Remove"
						onClick={() => {
							const next = rows.filter((other) => other.id !== row.id);
							setRows(next);
							save(next);
						}}
					>
						<X />
					</Button>
				</span>
			))}
			{rows.some((row) => row.sensitive) && (
				<span className="text-sm text-ink-muted">
					Sensitive values stay with the app server and are never shown here again.
				</span>
			)}
			{error !== undefined && <span className="text-sm text-destructive">{error}</span>}
		</div>
	);
}
