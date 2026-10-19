import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * The model catalog's bucket. CI publishes `v1/models.json` to it (`.github/workflows/catalog.yml`);
 * the live stage serves it at https://catalog.codework.sh/v1/models.json straight from R2, so no
 * Worker runs per request.
 */
export default Alchemy.Stack(
	"catalog",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage;
		const bucket = yield* Cloudflare.R2.Bucket("Bucket", {
			name: `catalog-${stage}`,
			domains: stage === "live" ? [{ name: "catalog.codework.sh", minTLS: "1.2" }] : [],
		});

		return {
			bucketName: bucket.bucketName,
		};
	}),
);
