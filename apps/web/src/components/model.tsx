import { Check, ChevronDown, FileSearch, Gauge, Search } from "@/components/vuesax";
import { type ModelProvider, ThinkingLevel } from "@codeworksh/widget/codework";
import { useAtomValue } from "@effect/atom-react";
import { Command as CommandPrimitive } from "cmdk";
import { Cause, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { useRef, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Server } from "../kernel/rpc";
import { codeworkKey, problemAtom } from "../kernel/servers";
import type { Notice } from "./banner";
import { OpenProviderSettings } from "./offline";
import { ProviderIcon } from "./provider";

export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

/** The start page's last model and reasoning picks; absent ones leave it to settings. */
const Choice = Schema.Struct({
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export type Choice = typeof Choice.Type;
const decodeChoice = Schema.decodeUnknownOption(Schema.fromJsonString(Choice));
const choiceKey = "codework.landing.choice";

function savedChoice(): Choice {
	try {
		return Option.getOrElse(decodeChoice(localStorage.getItem(choiceKey)), () => ({}));
	} catch {
		// Storage can be unavailable; settings decide.
		return {};
	}
}

/** The picks, kept in this window's storage so the start page reopens on them, after a restart too. */
export function useChoice() {
	const [choice, setChoice] = useState<Choice>(savedChoice);
	const update = (next: Choice) => {
		setChoice(next);
		try {
			localStorage.setItem(choiceKey, JSON.stringify(next));
		} catch {
			// The picks still apply until the page closes.
		}
	};
	return [choice, update] as const;
}

/** The models a session in `hostDir` can use; each folder has its own, since its settings may add some. */
const modelsAtom = Atom.family((hostDir: string | undefined) =>
	Server.query("models.list", hostDir === undefined ? {} : { hostDir }, { reactivityKeys: codeworkKey }),
);

/**
 * A broken settings file, as the composer's notice; it names the file, which the reader fixes. Any
 * other failure is the server's, which the pickers' place already points to.
 */
export function useModelsNotice(hostDir: string | undefined): Notice | undefined {
	const result = useAtomValue(modelsAtom(hostDir));
	const error = AsyncResult.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined;
	if (error?._tag !== "Server.ModelsError" || error.source !== "settings") return undefined;
	const { reveal } = window.desktopBridge ?? {};
	return {
		title: "Settings Error",
		description: error.message,
		tone: "error",
		...(reveal === undefined
			? {}
			: { actions: [{ label: "Reveal", icon: FileSearch, onClick: () => void reveal(error.path) }] }),
	};
}

// The composer toolbar pills share `bg-selection` and its hover.
const trigger =
	"group flex h-6.5 min-w-0 shrink-0 items-center gap-1 rounded-md bg-selection px-1.5 text-2xs text-ink transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-selection-hover focus-visible:ring-2 focus-visible:ring-ring enabled:active:scale-[0.97] data-[state=open]:bg-selection-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-selection";

/** A model's name and its provider's, when the list has it. */
const lookup = <P extends ModelProvider>(providers: ReadonlyArray<P>, ref: ModelRef) => {
	const provider = providers.find((candidate) => candidate.id === ref.provider);
	const model = provider?.models.find((candidate) => candidate.id === ref.id);
	return provider === undefined || model === undefined ? undefined : { provider, model };
};

/** Display name of `value` (or the settings default when `value` is absent), once `models.list` has loaded. */
export function useModelName(hostDir: string | undefined, value: ModelRef | undefined): string | undefined {
	const result = useAtomValue(modelsAtom(hostDir));
	const list = AsyncResult.isSuccess(result) ? result.value : undefined;
	const current = value ?? list?.default;
	if (current === undefined) return undefined;
	if (list !== undefined) {
		const found = lookup(list.providers, current);
		if (found !== undefined) return found.model.name;
		const fallback = list.default;
		if (
			fallback !== undefined &&
			current.provider === fallback.provider &&
			current.id === fallback.id &&
			fallback.name !== undefined
		) {
			return fallback.name;
		}
	}
	return current.id;
}

/**
 * Picks the model a new session uses: providers down a rail on the left, their models on the
 * right, and a search across all of them. `value` undefined means settings decide; the trigger
 * then shows the model they pick, muted when this server has no credentials for it.
 */
interface ModelPickerProps {
	readonly hostDir: string | undefined;
	readonly value: ModelRef | undefined;
	readonly onChange: (model: ModelRef) => void;
}

/** The model picker, or, while the default server has a problem, the way to the provider settings. */
export function ModelPicker(props: ModelPickerProps) {
	const problem = useAtomValue(problemAtom);
	return problem === undefined ? (
		<Models {...props} />
	) : (
		<OpenProviderSettings problem={problem} className="h-6.5 shrink-0 rounded-md bg-selection px-1.5 text-2xs" />
	);
}

function Models({ hostDir, value, onChange }: ModelPickerProps) {
	const result = useAtomValue(modelsAtom(hostDir));
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [rail, setRail] = useState<string>();
	const search = useRef<HTMLInputElement>(null);

	const list = AsyncResult.isSuccess(result) ? result.value : undefined;
	// The providers this server can call, plus the settings default's when it cannot: that one stays
	// in view, unavailable, so the model a session gets by default never silently drops out of sight.
	const usable = list?.providers.map((provider) => ({ ...provider, available: true })) ?? [];
	// With nothing to call, there is no model to keep in view either.
	const fallback = list?.default;
	const providers: ReadonlyArray<ModelProvider & { readonly available: boolean }> =
		fallback === undefined || usable.length === 0 || lookup(usable, fallback) !== undefined
			? usable
			: [
					...usable.filter((provider) => provider.id !== fallback.provider),
					{
						id: fallback.provider,
						name: fallback.providerName ?? fallback.provider,
						models: [{ id: fallback.id, name: fallback.name ?? fallback.id, thinkingLevels: [] }],
						available: false,
					},
				];
	const current = value ?? list?.default;
	const found = current === undefined ? undefined : lookup(providers, current);
	// The rail opens on the current model's provider, or the first one when that has no credentials.
	const shown =
		rail ?? (providers.some((provider) => provider.id === current?.provider) ? current?.provider : providers[0]?.id);

	// Searching looks across every provider; otherwise the list is the rail's provider.
	const needle = query.trim().toLowerCase();
	const rows = providers
		.filter((provider) => needle !== "" || provider.id === shown)
		.flatMap((provider) => provider.models.map((model) => ({ provider, model })))
		// Every word must appear somewhere in the model's name, its id or its provider's name.
		.filter(({ provider, model }) => {
			const text = `${model.name} ${model.id} ${provider.name}`.toLowerCase();
			return needle.split(/\s+/).every((word) => text.includes(word));
		});

	// The settings default can name a provider this server cannot call; it reads muted, not chosen.
	const none = list !== undefined && providers.length === 0;
	const unavailable = !none && current !== undefined && list !== undefined && found?.provider.available !== true;
	// Why is the composer's notice; the picker only reads as unusable until it clears.
	const failed = AsyncResult.isFailure(result);
	const label = failed ? "Unavailable" : none ? "No Models" : (found?.model.name ?? current?.id ?? "Choose model");
	const empty =
		list === undefined ? "Loading models…" : providers.length === 0 ? "No provider is signed in." : "No models found";

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setQuery("");
					setRail(undefined);
				}
			}}
		>
			<PopoverTrigger
				disabled={failed || none}
				title={
					current === undefined || failed || none
						? undefined
						: `${current.provider}/${current.id}${unavailable ? " — no credentials on this server" : ""}`
				}
				className={`${trigger} max-w-56`}
			>
				{current !== undefined && !failed && !none && (
					<ProviderIcon
						id={current.provider}
						name={found?.provider.name ?? current.provider}
						className="size-4 shrink-0"
					/>
				)}
				<span className={`truncate ${unavailable ? "text-ink-muted/60" : ""}`}>{label}</span>
				<ChevronDown
					className="size-3 shrink-0 text-ink-muted transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
					strokeWidth={1.75}
					aria-hidden
				/>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="bottom"
				sideOffset={4}
				// Below the composer, flipping above only when it does not fit there.
				collisionPadding={5}
				// Search takes focus on open, not the first provider, so typing filters straight away.
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					search.current?.focus();
				}}
				className="w-80 overflow-hidden rounded-xl border-ink/10 bg-popover/90 p-0 shadow-(--cw-menu-shadow) backdrop-blur-xl"
			>
				<div className="flex max-h-62 min-h-0 flex-row">
					<div
						role="toolbar"
						aria-label="Providers"
						aria-orientation="vertical"
						className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-edge p-1.5 scrollbar-none"
					>
						{providers.map((provider) => {
							const selected = needle === "" && provider.id === shown;
							return (
								<button
									key={provider.id}
									type="button"
									title={
										provider.available ? provider.name : `${provider.name} — no credentials on this server`
									}
									aria-label={provider.name}
									aria-pressed={selected}
									onClick={() => {
										setRail(provider.id);
										setQuery("");
										search.current?.focus();
									}}
									className={`grid size-8 shrink-0 place-items-center rounded-md transition-[transform,background-color,color] duration-150 ease-out outline-none active:scale-95 ${selected ? "bg-selection-strong text-ink" : "text-ink-muted hover:bg-selection-subtle hover:text-ink"} ${provider.available ? "" : "opacity-50"}`}
								>
									<ProviderIcon id={provider.id} name={provider.name} className="size-4" large />
								</button>
							);
						})}
					</div>
					<CommandPrimitive
						shouldFilter={false}
						// Opens on the current model, as the highlighted row.
						{...(current === undefined ? {} : { defaultValue: `${current.provider}/${current.id}` })}
						className="flex min-w-0 flex-1 flex-col"
					>
						<div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2 text-ink-muted">
							<Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
							<CommandPrimitive.Input
								ref={search}
								placeholder="Search models"
								value={query}
								onValueChange={setQuery}
								className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-muted/70"
							/>
						</div>
						<CommandPrimitive.List className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1 scrollbar-thin">
							<CommandPrimitive.Empty className="px-2 py-3 text-ui text-ink-muted">
								{empty}
							</CommandPrimitive.Empty>
							<div className="flex flex-col gap-0.5">
								{rows.map(({ provider, model }) => {
									const isCurrent = current?.provider === provider.id && current.id === model.id;
									return (
										<CommandPrimitive.Item
											key={`${provider.id}/${model.id}`}
											value={`${provider.id}/${model.id}`}
											// Shown so the default stays in view, but a session on it would fail.
											disabled={!provider.available}
											title={
												provider.available
													? undefined
													: `${provider.name} has no credentials on this server`
											}
											onSelect={() => {
												onChange({ provider: provider.id, id: model.id });
												setOpen(false);
											}}
											className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-body text-ink outline-none select-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:text-ink-muted/40 data-[selected=true]:bg-selection"
										>
											<span className="min-w-0 flex-1 truncate">{model.name}</span>
											{needle !== "" && (
												<span className="max-w-24 shrink-0 truncate text-3xs text-ink-muted">
													{provider.name}
												</span>
											)}
											{isCurrent && (
												<Check className="size-3.5 shrink-0 text-ink-muted" strokeWidth={2} aria-hidden />
											)}
										</CommandPrimitive.Item>
									);
								})}
							</div>
						</CommandPrimitive.List>
					</CommandPrimitive>
				</div>
			</PopoverContent>
		</Popover>
	);
}

const levelLabels: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};
const ladder = Object.keys(levelLabels) as ReadonlyArray<ThinkingLevel>;

/**
 * The level a run uses for `level` on a model supporting `levels`: the same, else the next one up,
 * else the next one down. The harness clamps the same way; this only shows what it will pick.
 */
const clamp = (level: ThinkingLevel, levels: ReadonlyArray<ThinkingLevel>) => {
	if (levels.includes(level)) return level;
	const at = ladder.indexOf(level);
	return (
		ladder.slice(at + 1).find((candidate) => levels.includes(candidate)) ??
		ladder
			.slice(0, at)
			.reverse()
			.find((candidate) => levels.includes(candidate)) ??
		levels[0]
	);
};

/**
 * Picks how hard the chosen model reasons, among the levels it supports. `value` undefined means
 * settings decide. Always in the row: for a model that does not reason, or one the list cannot
 * call, it reads "Reasoning" and does not open.
 */
interface ThinkingPickerProps {
	readonly hostDir: string | undefined;
	readonly model: ModelRef | undefined;
	readonly value: ThinkingLevel | undefined;
	readonly onChange: (level: ThinkingLevel) => void;
}

/** The reasoning picker; gone while the default server has a problem, as the model picker is. */
export function ThinkingPicker(props: ThinkingPickerProps) {
	return useAtomValue(problemAtom) === undefined ? <Thinking {...props} /> : null;
}

function Thinking({ hostDir, model, value, onChange }: ThinkingPickerProps) {
	const result = useAtomValue(modelsAtom(hostDir));
	const list = AsyncResult.isSuccess(result) ? result.value : undefined;
	const current = model ?? list?.default;
	const levels =
		list === undefined || current === undefined ? [] : (lookup(list.providers, current)?.model.thinkingLevels ?? []);
	const picked = useRef<HTMLDivElement>(null);
	const level = value ?? list?.default?.thinkingLevel;
	const shown = level === undefined ? undefined : clamp(level, levels);
	const choosable = shown !== undefined && levels.some((level) => level !== "off");

	return (
		<DropdownMenu
			// Focus moves to the current level once the menu opens, so it is the one row that reads as picked.
			onOpenChange={(open) => {
				if (open) requestAnimationFrame(() => picked.current?.focus());
			}}
		>
			<DropdownMenuTrigger
				disabled={!choosable}
				className={`${trigger} max-w-28`}
				title={
					choosable
						? `Reasoning: ${levelLabels[shown]}`
						: levels.length === 0
							? "Pick an available model to choose its reasoning"
							: "This model does not reason"
				}
			>
				<Gauge className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
				<span className="truncate">{choosable ? levelLabels[shown] : "Reasoning"}</span>
				<ChevronDown
					className="size-3 shrink-0 text-ink-muted transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
					strokeWidth={1.75}
					aria-hidden
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side="bottom"
				sideOffset={4}
				collisionPadding={5}
				className="min-w-44 rounded-xl border-ink/10 bg-popover/90 p-1 shadow-(--cw-menu-shadow) backdrop-blur-xl"
			>
				{levels.map((level) => (
					<DropdownMenuItem
						key={level}
						onSelect={() => onChange(level)}
						aria-current={level === shown}
						{...(level === shown ? { ref: picked } : {})}
						className="flex h-8 items-center justify-between gap-2 rounded-lg px-2 text-body text-ink focus:bg-selection aria-current:bg-selection/60"
					>
						<span className="min-w-0 flex-1 truncate">{levelLabels[level]}</span>
						{level === shown && (
							<Check className="size-3.5 shrink-0 text-ink-muted" strokeWidth={2} aria-hidden />
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
