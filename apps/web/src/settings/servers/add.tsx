import { useAtomSet } from "@effect/atom-react";
import { Check, Globe } from "lucide-react";
import { type ReactNode, useState } from "react";

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
import { Code, quietField } from "../blocks";
import { Badge, Mark, serversKey } from "./local";

const addAtom = Server.mutation("servers.add");

const STEPS = ["Kind", "Identity", "Config"] as const;

/**
 * Adds a server in three steps, as a provider is added elsewhere: what kind, what it is called, how
 * it runs. Only local servers for now. Nothing is saved until the last step.
 */
export function AddServer({
	onClose,
	defaultName,
	detected,
	onAdded,
}: {
	onClose: () => void;
	defaultName: string;
	/** The `codework` found without a choice, shown as the executable's default. */
	detected: string | undefined;
	onAdded: (id: string) => void;
}) {
	const add = useAtomSet(addAtom, { mode: "promise" });
	const [step, setStep] = useState(0);
	const [name, setName] = useState(defaultName);
	const [executable, setExecutable] = useState("");
	const [home, setHome] = useState("");
	// A free port, so the new server runs beside the others rather than on the default one.
	const [args, setArgs] = useState("--port 0");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		setAdding(true);
		setError(null);
		add({
			payload: { name, executable: executable.trim() || null, home, args },
			reactivityKeys: serversKey,
		})
			.then((id) => {
				onAdded(id);
				onClose();
			})
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setAdding(false));
	};

	const canContinue = step === 0 || (step === 1 && name.trim() !== "") || (step === 2 && home.trim() !== "");

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-5 text-[14px] sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Add server</DialogTitle>
					<DialogDescription>Run another codework server on this machine, with its own home.</DialogDescription>
				</DialogHeader>

				<ol className="grid grid-cols-3 gap-1 rounded-lg bg-ink/4 p-1">
					{STEPS.map((label, index) => (
						<li
							key={label}
							aria-current={index === step ? "step" : undefined}
							className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] ${index === step ? "bg-ink/6 text-ink" : "text-ink-muted"}`}
						>
							<span
								className={`grid size-5 place-items-center rounded-full text-[11px] ${index < step ? "bg-info text-white" : "bg-ink/8"}`}
							>
								{index < step ? <Check className="size-3" /> : index + 1}
							</span>
							{label}
						</li>
					))}
				</ol>

				{step === 0 && (
					<div className="flex flex-col gap-2">
						<span className="font-medium">Kind</span>
						<div className="grid grid-cols-2 gap-2">
							<KindTile selected icon={<Mark />} title="Local" detail="Runs on this machine" />
							<KindTile
								icon={<Globe className="size-5 text-ink-muted" strokeWidth={1.75} />}
								title="Remote"
								detail="Another machine's server"
								badge={<Badge tone="info">Coming soon</Badge>}
							/>
						</div>
					</div>
				)}

				{step === 1 && (
					<div className="flex flex-col divide-y divide-edge rounded-xl border border-edge">
						<Row title="Name" description="Shown in the server list.">
							<Input
								aria-label="Name"
								value={name}
								autoFocus
								className={quietField}
								onChange={(event) => setName(event.target.value)}
								onKeyDown={(event) => event.key === "Enter" && canContinue && setStep(2)}
							/>
						</Row>
					</div>
				)}

				{step === 2 && (
					<div className="flex flex-col divide-y divide-edge rounded-xl border border-edge">
						<Row title="Executable" description="Path to the codework binary used by this instance.">
							<Input
								aria-label="Executable"
								value={executable}
								placeholder={detected ?? "codework"}
								className={`${quietField} font-mono text-[12px] md:text-[12px]`}
								onChange={(event) => setExecutable(event.target.value)}
							/>
						</Row>
						<Row
							title={
								<>
									<Code>CODEWORK_HOME_DIR</Code> path
								</>
							}
							description="codework home and config directory, its own: a home names one server."
						>
							<Input
								aria-label="CODEWORK_HOME_DIR path"
								value={home}
								autoFocus
								placeholder="~/.codework-2"
								className={`${quietField} font-mono text-[12px] md:text-[12px]`}
								onChange={(event) => setHome(event.target.value)}
							/>
						</Row>
						<Row
							title="Launch Args"
							description={
								<>
									Additional CLI arguments passed to <Code>codework service start</Code>. <Code>--port 0</Code>{" "}
									picks a free port.
								</>
							}
						>
							<Input
								aria-label="Launch Args"
								value={args}
								className={`${quietField} font-mono text-[12px] md:text-[12px]`}
								onChange={(event) => setArgs(event.target.value)}
							/>
						</Row>
					</div>
				)}

				{error !== null && <p className="text-[13px] text-destructive">{error}</p>}

				<DialogFooter>
					{step === 0 ? (
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
					) : (
						<Button variant="ghost" disabled={adding} onClick={() => setStep(step - 1)}>
							Back
						</Button>
					)}
					{step < 2 ? (
						<Button disabled={!canContinue} onClick={() => setStep(step + 1)}>
							Next
						</Button>
					) : (
						<Button disabled={!canContinue || adding} onClick={submit}>
							{adding ? "Adding…" : "Add server"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** One kind of server to pick; a tile without `selected` cannot be picked yet. */
function KindTile({
	selected = false,
	icon,
	title,
	detail,
	badge,
}: {
	selected?: boolean;
	icon: ReactNode;
	title: string;
	detail: string;
	badge?: ReactNode;
}) {
	return (
		<div
			role="radio"
			aria-checked={selected}
			aria-disabled={!selected}
			className={`flex items-center gap-3 rounded-lg border px-3 py-3 ${selected ? "border-info bg-info/8" : "border-edge opacity-60"}`}
		>
			{icon}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="font-medium">{title}</span>
				<span className="text-[12px] text-ink-muted">{detail}</span>
			</span>
			{badge}
			{selected && <Check className="size-4 text-info" />}
		</div>
	);
}

/** A setting in the dialog: its title and description beside its field. */
function Row({ title, description, children }: { title: ReactNode; description: ReactNode; children: ReactNode }) {
	return (
		<div className="grid items-center gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[1fr_16rem]">
			<span className="flex flex-col gap-1">
				<span className="font-medium">{title}</span>
				<span className="text-[13px] text-ink-muted">{description}</span>
			</span>
			{children}
		</div>
	);
}
