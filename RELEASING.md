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
     `npm publish --provenance --access public`.

## One-time setup

- Add an `NPM_TOKEN` repository secret — an npm **Automation** or **Granular Access** token with
  publish rights to `@kolegaai/cli` (Settings → Secrets and variables → Actions).
- Provenance requires `id-token: write` (already set in the workflow) and a **public** repository.

## Manual publish (fallback)

If you must publish locally:

```sh
npm login                 # passkey / 2FA happens in the browser
rm -rf dist               # avoid shipping stale build artifacts
npm publish --access public
```
