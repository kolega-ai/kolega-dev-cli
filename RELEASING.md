# Releasing

`@kolegaai/cli` is published to npm automatically by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) whenever a **GitHub Release** is
published. You should not need to run `npm publish` by hand.

## Cutting a release

1. **Bump the version** on a branch and merge it to `main`:
   - Edit `version` in `package.json` following semver — breaking → major, feature → minor, fix →
     patch.
2. **Publish a GitHub Release** whose tag is `v<version>` (it must match `package.json`):
   ```sh
   gh release create v2.1.0 --title v2.1.0 --notes "…release notes…"
   ```
3. The **Publish to npm** workflow then runs on the published release:
   - installs deps, verifies the release tag matches `package.json`, and **skips** if that version
     is already on npm (so re-running is safe);
   - runs `prepublishOnly` (`generate-types → lint → test → build`) and publishes with
     `npm publish` via **trusted publishing**.

## One-time setup (trusted publishing)

This repo uses npm **trusted publishing** (OIDC) — there is **no `NPM_TOKEN`** to create, store, or
rotate. npm authenticates the workflow via GitHub's OIDC token. Configure it once on the package:

1. npmjs.com → the `@kolegaai/cli` package → **Settings** → **Trusted Publisher**.
2. Add a **GitHub Actions** publisher:
   - Organization or user: `kolega-ai`
   - Repository: `kolega-dev-cli`
   - Workflow filename: `publish.yml`
   - Environment: leave blank (the workflow defines none).

The workflow already grants `id-token: write`; provenance attestations are generated automatically
(the repository is public).

## Manual publish (fallback)

If you must publish locally:

```sh
npm login                 # passkey / 2FA happens in the browser
rm -rf dist               # avoid shipping stale build artifacts
npm publish --access public
```
