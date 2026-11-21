import { useAtomSet } from "@effect/atom-react";
import { PairingRefused, type RemoteServerStatus } from "@codeworksh/contract";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { type ComponentProps, type FormEvent, useId, useRef, useState } from "react";

import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { messageOf } from "@/lib/utils";
import { Server } from "../../kernel/rpc";
import { updateAtom } from "../../kernel/servers";
import { DialogRow, quietField } from "../blocks";

const addAtom = Server.mutation("servers.add");

const PAIR_COMMAND = "codework service pair";

const PORT = 7433;

/** The WebSocket scheme each scheme a person may type stands for. */
const SCHEMES: Readonly<Record<string, "ws" | "wss">> = { ws: "ws", http: "ws", wss: "wss", https: "wss" };

/** An address as typed: the scheme it names, if any, then its host and port, without a path. */
const parse = (typed: string) => {
	const text = typed.trim();
	const scheme = /^([a-z]+):\/\//i.exec(text)?.[1]?.toLowerCase();
	const rest = text.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
	// A bare IPv6 address has colons of its own and no port.
	const [, host = rest, port] = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(rest) ?? [];
	return { scheme, host: host.includes(":") && !host.startsWith("[") ? `[${host}]` : host, port };
};

/**
 * TLS unless the host is an IP address, `localhost`, a `.local` name or a name without a dot:
 * certificates are issued for domain names.
 */
const defaultScheme = (host: string) =>
	/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.endsWith(".local") || !host.includes(".")
		? "ws"
		: "wss";

/**
 * The URL for an address as typed; empty for none. A typed scheme wins; otherwise {@link defaultScheme}.
 * Without a port, plain is on the default port and TLS on 443.
 */
export const urlOf = (typed: string) => {
	const { scheme, host, port } = parse(typed);
	if (host === "") return "";
	const ws = scheme === undefined ? defaultScheme(host) : SCHEMES[scheme];
	if (ws === undefined) return "";
	const at = port ?? (ws === "ws" ? String(PORT) : undefined);
	return `${ws}://${host}${at === undefined ? "" : `:${at}`}/rpc/v1`;
};

/** Whether a URL reaches its machine without TLS. */
export const isPlain = (url: string) => url.startsWith("ws:");

export const NOT_ENCRYPTED = "This connection is not encrypted";

/** Where a paired machine is, as `host:port`, with its scheme when it is not the one the host defaults to. */
export const addressOf = (url: string) => {
	if (!URL.canParse(url)) return url;
	const { protocol, host } = new URL(url);
	return urlOf(host).startsWith(protocol) ? host : `${protocol}//${host}`;
};

/** A pairing code as typed: any case, with or without its dash. */
const plainCode = (typed: string) =>
	typed
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.slice(0, 10);

/** `XXXXX-XXXXX`, as far as it has been typed. */
const formatCode = (typed: string) => {
	const plain = plainCode(typed);
	return plain.length > 5 ? `${plain.slice(0, 5)}-${plain.slice(5)}` : plain;
};

type Field = "address" | "code";

/**
 * A pairing form's fields and failures. A failure sits under its own field, which takes focus with its
 * text selected; changing that field clears it.
 */
function usePairForm() {
	const id = useId();
	const address = useRef<HTMLInputElement>(null);
	const code = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ readonly field: Field; readonly text: string } | null>(null);
	const errorId = (field: Field) => `${id}-${field}-error`;

	const fail = (field: Field, text: string) => {
		setFailure({ field, text });
		const input = (field === "address" ? address : code).current;
		input?.focus();
		input?.select();
	};
	return {
		busy,
		address,
		/**
		 * Validates first: `check` answers a failure to show, or null to go on and pair. A refused code
		 * fails under the code; anything else under `other`.
		 */
		submit:
			<A,>({
				check,
				pair,
				done,
				other,
			}: {
				check: () => { field: Field; text: string } | null;
				pair: () => Promise<A>;
				done: (value: A) => void;
				other: Field;
			}) =>
			(event: FormEvent) => {
				event.preventDefault();
				if (busy) return;
				const invalid = check();
				if (invalid !== null) return fail(invalid.field, invalid.text);
				setBusy(true);
				setFailure(null);
				pair().then(
					(value) => {
						setBusy(false);
						done(value);
					},
					(cause: unknown) => {
						setBusy(false);
						fail(cause instanceof PairingRefused ? "code" : other, messageOf(cause));
					},
				);
			},
		/** The props a field needs for its failure, and to stay put while pairing. */
		field: (field: Field) => ({
			id: `${id}-${field}`,
			ref: field === "address" ? address : code,
			"aria-invalid": failure?.field === field ? true : undefined,
			"aria-describedby": failure?.field === field ? errorId(field) : undefined,
			autoComplete: "off",
			spellCheck: false,
			readOnly: busy,
		}),
		/** The field's failure, shown under it. */
		error: (field: Field) =>
			failure?.field === field && (
				<p id={errorId(field)} className="flex items-start gap-1.5 text-xs text-destructive">
					<WarningCircleIcon size={14} weight="fill" className="mt-px shrink-0" aria-hidden />
					<span>{failure.text}</span>
				</p>
			),
		clear: (field: Field) => {
			if (failure?.field === field) setFailure(null);
		},
	};
}

const checkCode = (code: string) =>
	plainCode(code).length === 10
		? null
		: { field: "code" as const, text: "The pairing code is 10 letters and digits." };

/** A pairing code field, formatted as it is typed. */
function CodeInput({
	value,
	onChange,
	className,
	...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange"> & {
	value: string;
	onChange: (code: string) => void;
}) {
	return (
		<Input
			{...props}
			value={value}
			placeholder="XXXXX-XXXXX"
			maxLength={11}
			className={`${quietField} font-mono tracking-widest uppercase ${className ?? ""}`}
			onChange={(event) => onChange(formatCode(event.target.value))}
		/>
	);
}

/** Pairs a new machine; nothing is stored until its code is accepted. */
export function PairDialog({ onClose, onPaired }: { onClose: () => void; onPaired: (id: string) => void }) {
	const add = useAtomSet(addAtom, { mode: "promise" });
	const form = usePairForm();
	const [address, setAddress] = useState("");
	const [code, setCode] = useState("");
	const submit = form.submit({
		check: () =>
			urlOf(address) === "" ? { field: "address", text: "Enter the Machine’s address." } : checkCode(code),
		pair: () => add({ payload: { kind: "remote", url: urlOf(address), code } }),
		done: onPaired,
		other: "address",
	});
	return (
		<Dialog open onOpenChange={(next) => !next && !form.busy && onClose()}>
			<DialogContent
				className="gap-5 text-sm sm:max-w-2xl"
				onOpenAutoFocus={(event) => {
					// The first field, not the copy button before it.
					event.preventDefault();
					form.address.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>Pair a Machine</DialogTitle>
					<DialogDescription>Only this computer reaches it.</DialogDescription>
				</DialogHeader>
				<form noValidate onSubmit={submit} className="flex min-w-0 flex-col gap-5">
					<div className="flex flex-col divide-y divide-edge rounded-xl border border-edge">
						<DialogRow title="Run on the Machine" description="It prints a Code, valid 10 minutes">
							<CopyCommand command={PAIR_COMMAND} />
						</DialogRow>
						<DialogRow
							title="Address"
							description="Where this computer reaches it"
							htmlFor={form.field("address").id}
						>
							<Input
								{...form.field("address")}
								value={address}
								placeholder="host or host:port"
								className={`${quietField} font-mono text-xs md:text-xs`}
								onChange={(event) => {
									setAddress(event.target.value);
									form.clear("address");
								}}
							/>
							{form.error("address") ||
								(isPlain(urlOf(address)) && <p className="text-xs text-ink-muted">{NOT_ENCRYPTED}</p>)}
						</DialogRow>
						<DialogRow
							title="Pairing Code"
							description="The Code that command printed"
							htmlFor={form.field("code").id}
						>
							<CodeInput
								{...form.field("code")}
								value={code}
								onChange={(next) => {
									setCode(next);
									form.clear("code");
								}}
							/>
							{form.error("code")}
						</DialogRow>
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={form.busy} onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={form.busy}>
							{form.busy ? "Pairing…" : "Pair Machine"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Pairs a machine again, at its address, with a new code. */
export function PairAgain({ server }: { server: RemoteServerStatus }) {
	const update = useAtomSet(updateAtom, { mode: "promise" });
	const form = usePairForm();
	const [code, setCode] = useState("");
	const submit = form.submit({
		check: () => checkCode(code),
		pair: () => update({ payload: { id: server.id, code } }),
		done: () => setCode(""),
		other: "code",
	});
	return (
		<div className="flex flex-col gap-3 px-4 py-3.5">
			<span className="text-xs font-book text-ink-muted">
				Run this on {server.name}, then enter the Code it prints. Valid 10 minutes.
			</span>
			<CopyCommand command={PAIR_COMMAND} />
			<form noValidate onSubmit={submit} className="flex min-w-0 flex-col gap-1.5">
				<div className="flex min-w-0 items-center gap-2">
					<label htmlFor={form.field("code").id} className="sr-only">
						Pairing Code
					</label>
					<CodeInput
						{...form.field("code")}
						value={code}
						className="flex-1"
						onChange={(next) => {
							setCode(next);
							form.clear("code");
						}}
					/>
					<Button type="submit" size="sm" className="min-w-24" disabled={form.busy}>
						{form.busy ? "Pairing…" : "Pair Again"}
					</Button>
				</div>
				{form.error("code")}
			</form>
		</div>
	);
}
