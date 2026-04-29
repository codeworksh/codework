import { InstanceBootstrap } from "../project/bootstrap.ts";
import { Instance } from "../project/instance.ts";

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
	return Instance.provide({
		directory,
		init: InstanceBootstrap,
		fn: async () => {
			try {
				const result = await cb();
				return result;
			} finally {
				await Instance.dispose();
			}
		},
	});
}
