import { create, RealFSProvider } from "@platformatic/vfs";
import { Layer } from "effect";
import { Local } from "./filesystem/local";
import { Process } from "./utils/process";

export interface Options {
	/** Host working directory used to resolve relative filesystem paths. */
	readonly cwd: string;
}

const optionsFrom = (input: string | Options): Options => (typeof input === "string" ? { cwd: input } : input);

export const layer = (input: string | Options) => {
	const options = optionsFrom(input);
	const vfs = create(new RealFSProvider("/"), {
		moduleHooks: false,
		virtualCwd: true,
	});

	vfs.chdir(options.cwd);

	return Layer.merge(Layer.succeed(Local.Vfs, vfs), Process.host);
};

export * as EnvNodeJSDefault from "./nodejs";
