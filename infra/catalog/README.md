# catalog.codework.sh

The R2 bucket that serves the model catalog at `https://catalog.codework.sh/v1/models.json`, straight from R2: no Worker runs per request.

- **Deploy** (from your machine, with your Cloudflare login): `vp run --filter @codeworksh/catalog deploy`. It creates the `catalog-live` bucket and attaches the `catalog.codework.sh` custom domain.
- **Publish**: `.github/workflows/catalog.yml` runs hourly and on demand. It builds the catalog with `vp run catalog` in `packages/aikit`, refuses one that fails its checks, and uploads `v1/models.json` only when it changed. The workflow's `catalog` environment needs:
   - `CATALOG_R2_ACCESS_KEY_ID` and `CATALOG_R2_SECRET_ACCESS_KEY`: an R2 API token with Object Read & Write on `catalog-live` only (Cloudflare dashboard, R2, Manage API tokens).
   - `CATALOG_R2_ENDPOINT`: `https://<account id>.r2.cloudflarestorage.com`.
- **Clients**: the harness downloads the catalog on refresh (`downloadCatalog` in `@codeworksh/aikit/modelgen`), sending the MD5 of its last download as `If-None-Match`, so an unchanged catalog answers 304. `CODEWORK_CATALOG_URL` points a client elsewhere.

`v1` is the schema version: additive changes stay in `v1`, a breaking change publishes `v2/` alongside it.
