import { QuickJS } from "quickjs-wasi";
import type { CodeMode } from "../codemode";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;

function withMessageInStack(message: string, stack: string | undefined): string | undefined {
	if (!stack) return undefined;
	return stack.includes(message) ? stack : `${message}\n${stack}`;
}

function parseErrorLine(stack: unknown): number | undefined {
	if (typeof stack !== "string") return undefined;
	const lineMatch = stack.match(/:(\d+)(?::\d+)?\)?$/m);
	return lineMatch ? Number(lineMatch[1]) : undefined;
}

function normalizeExecutionError(error: unknown): CodeMode.NormalizedError {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: withMessageInStack(error.message, error.stack),
			line: parseErrorLine(error.stack),
		};
	}

	if (typeof error === "object" && error !== null) {
		const candidate = error as Record<string, unknown>;
		const message =
			typeof candidate.message === "string"
				? candidate.message
				: JSON.stringify(candidate) || "Unknown Execution Error";
		return {
			name: typeof candidate.name === "string" ? candidate.name : undefined,
			message,
			stack: typeof candidate.stack === "string" ? withMessageInStack(message, candidate.stack) : undefined,
			line: typeof candidate.line === "number" ? candidate.line : parseErrorLine(candidate.stack),
		};
	}

	return {
		name: "Error",
		message: String(error),
	};
}

function toMegabytes(value: number | undefined): number {
	return (value ?? DEFAULT_MEMORY_LIMIT_MB) * 1024 * 1024;
}

function createConsole(vm: QuickJS, logs: string[]) {
	const consoleObject = vm.newObject();
	const methods = [
		["log", ""],
		["info", "INFO: "],
		["warn", "WARN: "],
		["error", "ERROR: "],
	] as const;

	for (const [name, prefix] of methods) {
		const fn = vm.newFunction(name, (...args) => {
			const message = args.map((arg) => String(vm.dump(arg))).join(" ");
			logs.push(`${prefix}${message}`);
			return vm.undefined;
		});
		consoleObject.setProp(name, fn);
	}

	vm.setProp(vm.global, "console", consoleObject);
}

function registerBindings(vm: QuickJS, bindings: Record<string, CodeMode.ToolBinding>, signal?: AbortSignal) {
	let callCounter = 0;

	for (const [name, binding] of Object.entries(bindings)) {
		const fn = vm.newFunction(name, (...args) => {
			const input = args[0] ? vm.dump(args[0]) : undefined;
			const result = Promise.resolve(binding.execute(`${name}:${++callCounter}`, input, signal));
			return vm.hostToHandle(result);
		});
		vm.setProp(vm.global, name, fn);
	}
}

export function createQuickJSWasiDriver(): CodeMode.Driver {
	return {
		async createContext(config: CodeMode.DriverContextConfig): Promise<CodeMode.Context> {
			const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
			const deadline = Date.now() + timeout;
			const logs: string[] = [];
			// create VM for execution sandbox
			const vm = await QuickJS.create({
				memoryLimit: toMegabytes(config.memoryLimit),
				interruptHandler: () => Boolean(config.signal?.aborted) || Date.now() > deadline,
			});

			// create console log bindings
			createConsole(vm, logs);
			// register tool fn bindings
			registerBindings(vm, config.bindings, config.signal);

			return {
				async execute<T = unknown>(code: string) {
					let resultHandle: ReturnType<typeof vm.evalCode> | undefined;

					try {
						resultHandle = vm.evalCode(code, "script.js");
						vm.executePendingJobs();

						const settled = await vm.resolvePromise(resultHandle);
						if ("error" in settled) {
							try {
								return {
									success: false,
									error: normalizeExecutionError(vm.dump(settled.error)),
									logs: [...logs],
								};
							} finally {
								settled.error.dispose();
							}
						}

						try {
							return {
								success: true,
								value: vm.dump(settled.value) as T,
								logs: [...logs],
							};
						} finally {
							settled.value.dispose();
						}
					} catch (error) {
						return {
							success: false,
							error: normalizeExecutionError(error),
							logs: [...logs],
						};
					} finally {
						resultHandle?.dispose();
					}
				},
				async dispose() {
					vm.dispose();
				},
			};
		},
	};
}
