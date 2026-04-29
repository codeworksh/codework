import { type GlobOptions, glob, globSync } from "glob";
import { minimatch } from "minimatch";

export namespace Glob {
	export interface Options {
		cwd?: string;
		absolute?: boolean;
		include?: "file" | "all";
		dot?: boolean;
		symlink?: boolean;
	}

	function toGlobOptions(options: Options): GlobOptions {
		return {
			cwd: options.cwd,
			absolute: options.absolute,
			dot: options.dot,
			follow: options.symlink ?? false,
			nodir: options.include !== "all",
		};
	}

	export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
		const results = await glob(pattern, toGlobOptions(options));
		// If results are Path objects, they stringify automatically,
		// but a simple cast to string[] usually suffices for the compiler here.
		return results as string[];
	}

	export function scanSync(pattern: string, options: Options = {}): string[] {
		return globSync(pattern, toGlobOptions(options)) as string[];
	}

	export function match(pattern: string, filepath: string): boolean {
		return minimatch(filepath, pattern, { dot: true });
	}
}
