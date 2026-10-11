import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
	"www",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage;
		const bucket = yield* Cloudflare.R2.Bucket("Bucket", { name: `www-bucket-${stage}` });

		const site = yield* Cloudflare.Website.StaticSite("Website", {
			name: "www",
			command: "pnpm run build",
			outdir: "dist",
		});

		return {
			bucketName: bucket.bucketName,
			url: site.url,
		};
	}),
);
