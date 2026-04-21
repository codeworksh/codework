import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ToastType = "default" | "error" | "info" | "loading" | "success" | "warning";

interface ToastInput {
	title?: ReactNode;
	description?: ReactNode;
	timeout?: number;
	type?: ToastType;
}

interface ToastRecord extends ToastInput {
	id: string;
	createdAt: number;
}

interface ToastManager {
	add: (toast: ToastInput) => string;
	close: (id: string) => void;
	getSnapshot: () => ToastRecord[];
	subscribe: (listener: () => void) => () => void;
	update: (id: string, toast: ToastInput) => void;
}

const DEFAULT_TOAST_TIMEOUT_MS = 5_000;

function createToastManager(): ToastManager {
	let toasts: ToastRecord[] = [];
	const listeners = new Set<() => void>();

	function emit(): void {
		for (const listener of listeners) {
			listener();
		}
	}

	return {
		add: (toast) => {
			const id = crypto.randomUUID();
			toasts = [...toasts, { ...toast, id, createdAt: Date.now() }];
			emit();
			return id;
		},
		close: (id) => {
			toasts = toasts.filter((toast) => toast.id !== id);
			emit();
		},
		getSnapshot: () => toasts,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		update: (id, toast) => {
			toasts = toasts.map((current) => (current.id === id ? { ...current, ...toast } : current));
			emit();
		},
	};
}

export const toastManager = createToastManager();
export const anchoredToastManager = createToastManager();

const ToastContext = createContext<ToastManager>(toastManager);

interface ToastProviderProps {
	children: ReactNode;
	manager?: ToastManager;
}

export function ToastProvider({ children, manager = toastManager }: ToastProviderProps) {
	return (
		<ToastContext.Provider value={manager}>
			{children}
			<ToastViewport manager={manager} />
		</ToastContext.Provider>
	);
}

export function AnchoredToastProvider({ children }: { children: ReactNode }) {
	return (
		<>
			{children}
			<ToastViewport manager={anchoredToastManager} anchored />
		</>
	);
}

export function useToastManager(): ToastManager {
	return useContext(ToastContext);
}

function useToasts(manager: ToastManager): ToastRecord[] {
	const [toasts, setToasts] = useState(() => manager.getSnapshot());

	useEffect(() => {
		return manager.subscribe(() => {
			setToasts(manager.getSnapshot());
		});
	}, [manager]);

	return toasts;
}

function ToastViewport({ anchored = false, manager }: { anchored?: boolean; manager: ToastManager }) {
	const toasts = useToasts(manager);

	if (toasts.length === 0) {
		return null;
	}

	return (
		<div
			className={cn(
				"fixed right-4 z-100 flex w-[min(calc(100vw-2rem),22rem)] flex-col gap-2 outline-none sm:right-6",
				anchored ? "bottom-4 sm:bottom-6" : "top-4 sm:top-6",
			)}
			data-slot={anchored ? "anchored-toast-viewport" : "toast-viewport"}
		>
			{toasts.map((toast) => (
				<ToastItem key={toast.id} manager={manager} toast={toast} />
			))}
		</div>
	);
}

function ToastItem({ manager, toast }: { manager: ToastManager; toast: ToastRecord }) {
	const timeout = toast.timeout ?? DEFAULT_TOAST_TIMEOUT_MS;
	const Icon = useMemo(() => {
		switch (toast.type) {
			case "error":
				return AlertCircleIcon;
			case "info":
				return InfoIcon;
			case "loading":
				return LoaderCircleIcon;
			case "success":
				return CheckCircle2Icon;
			case "warning":
				return TriangleAlertIcon;
			default:
				return null;
		}
	}, [toast.type]);

	useEffect(() => {
		if (timeout <= 0) {
			return;
		}

		const handle = window.setTimeout(() => {
			manager.close(toast.id);
		}, timeout);

		return () => {
			window.clearTimeout(handle);
		};
	}, [manager, timeout, toast.id]);

	return (
		<div
			className="animate-in fade-in-0 slide-in-from-right-2 relative overflow-hidden rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
			data-slot="toast"
			data-type={toast.type ?? "default"}
		>
			<div className="flex items-start gap-2 pr-7">
				{Icon ? (
					<Icon
						className={cn(
							"mt-0.5 size-4 shrink-0",
							toast.type === "error" && "text-destructive",
							toast.type === "loading" && "animate-spin text-muted-foreground",
							toast.type === "success" && "text-emerald-600 dark:text-emerald-400",
							toast.type === "warning" && "text-amber-600 dark:text-amber-400",
						)}
					/>
				) : null}
				<div className="min-w-0 flex-1">
					{toast.title ? <div className="text-sm font-medium wrap-break-word">{toast.title}</div> : null}
					{toast.description ? (
						<div className="mt-0.5 text-xs/relaxed text-muted-foreground wrap-break-word">
							{toast.description}
						</div>
					) : null}
				</div>
			</div>
			<Button
				aria-label="Dismiss toast"
				className="absolute top-2 right-2"
				onClick={() => manager.close(toast.id)}
				size="icon-sm"
				variant="ghost"
			>
				<XIcon />
			</Button>
		</div>
	);
}
