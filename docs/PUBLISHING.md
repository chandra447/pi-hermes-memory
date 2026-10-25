# Publishing

`pi-hermes-memory` ships to npm. [pi.dev/packages](https://pi.dev/packages) indexes it automatically from the `pi-package` keyword — there is no gallery submission step. The same workflow run that publishes to npm also creates the matching GitHub Release.

## Workflows

|Workflow|Trigger|Job|
|---|---|---|
|`publish.yml`|publishing a GitHub Release, `workflow_dispatch`, or a dispatch fired by `release.yml`. A pushed tag alone does not trigger it|verify → publish to npm → GitHub Release|
|`release.yml`|`workflow_dispatch`|bump `package.json`, promote `CHANGELOG.md`, commit to `main`, push the tag, then dispatch `publish.yml`|

Both run on `ubuntu-latest`. See [Runners](#runners) for why.

### `verify` — the release gate

Runs against the exact commit being published:

1. Resolves the target ref (tag, branch or SHA) and the publish mode.
2. Fails if a `v*` ref does not name exactly the `package.json` version.
3. Fails if the version is a prerelease published under `latest`.
4. Marks the version `already-published` if npm has it — **not** a failure: publishing is skipped and the rest of the pipeline still runs, so a re-run reconciles a missing GitHub Release instead of dying.
5. `npm ci`, `npm run check` (tsc), `npm test` (732 tests), `npm run check:production` (packs the tarball, installs it without peers, loads it through Pi's jiti loader and runs four loopback completions).
6. Warns if `CHANGELOG.md` has no section for the version.

Nothing reaches the registry unless all of that passes.

### `publish` — npm, via OIDC

`npm publish --access public --tag <dist-tag>` from the `publish` environment, using **trusted publishing**: GitHub mints a short-lived OIDC token from the workflow identity, so there is no `NPM_TOKEN` secret to leak or rotate. Provenance attestations are generated automatically — no `--provenance` flag needed.

`npm stage publish` instead of `npm publish` when the dispatch sets `stage: true`: the version lands in npm's staging area and stays invisible until a maintainer approves it with 2FA on npmjs.com.

### `release` — GitHub Release

Notes come from the version's `CHANGELOG.md` section. If that section is missing the release is still created, with `--generate-notes` and a warning annotation. Re-running a publish is safe: an existing release is left untouched.

## One-time setup: the npm trusted publisher

Trusted publishing is configured on npm, not in this repo. Pick either route — both need your npm account, 2FA, and write access to the package.

**CLI (from an authenticated checkout):**

```bash
npm login
npm trust github pi-hermes-memory \
  --file publish.yml \
  --repo chandra447/pi-hermes-memory \
  --env publish \
  --allow-publish \
  --allow-stage-publish
```

`npm trust list pi-hermes-memory` shows the current configuration. The registry allows **one** trust configuration per package — if one already exists, `npm trust revoke --id <id> pi-hermes-memory` first, then re-create it.

**Web UI:** npmjs.com → pi-hermes-memory → Settings → Trusted publishing → Add trusted publisher → GitHub Actions:

|Field|Value|
|---|---|
|Organization or user|`chandra447`|
|Repository|`pi-hermes-memory`|
|Workflow filename|`publish.yml` (filename only — no path)|
|Environment name|`publish` (must match `environment:` in the workflow; leave blank on npm to skip the environment claim)|
|Allowed actions|`npm publish` **and** `npm stage publish`|

> Configurations created after 2026-09-03 enable `npm stage publish` automatically. `npm publish` must be granted explicitly — via `--allow-publish` or the checkbox — or the direct publish step fails with a 403.

No repository secret is required. (`secrets.NPM_TOKEN` never existed — its absence is why the 2026-07-26 dispatch run died with `ENEEDAUTH`.)

## Releasing

### Normal release — one dispatch

**Actions → Prepare release → Run workflow**

- `bump`: `patch` | `minor` | `major` — or
- `version`: an explicit version such as `0.10.0` (required for prereleases)
- `dist-tag`: `latest`, or `next` for a prerelease
- `dry-run`: `true` prints the computed version and validates the changelog without committing anything

It then bumps `package.json`, moves everything under `## [Unreleased]` into `## [<version>] - <date>`, commits `chore(release): v<version>` to `main`, pushes the tag, and dispatches `publish.yml` with that tag. It is a dispatch, not a reusable-workflow call, because npm validates the trusted publisher against the top-level workflow — which must be `publish.yml`.

Write the `[Unreleased]` section before dispatching; it becomes the release notes verbatim. The promotion never rewrites the prose.

### Release by tag

For a manually prepared release (bump and changelog already merged), push the tag and then start the pipeline for it. Pushing the tag does not start it:

```bash
git tag -a v0.9.11 -m v0.9.11
git push origin v0.9.11
```

Then **Actions → Publish to npm → Run workflow** with `ref: v0.9.11` — or publish a GitHub Release for that existing tag. The tag must match `package.json` exactly, or `verify` fails.

### Release-first: the GitHub Release is the trigger

Publishing a GitHub Release starts the pipeline (`release: types: [published]`), which is npm's own documented pattern — write the notes in the GitHub UI, hit **Publish release**, and npm publish follows. The tag comes from the release, so the tag↔version guard still applies.

**The tradeoff is ordering.** In this path the Release page is public *before* the package is installable. If the publish then fails, the release advertises a version npm does not have until you re-dispatch. The tag-first paths keep the stronger invariant: a release exists only once the package is live on npm.

The pipeline is idempotent, so a repeat is safe:

- A second run for a version already on npm finds it there: publishing is skipped, the run stays green, and no second publish happens even in principle — npm rejects re-publishing a version regardless.
- Creating a release for a **new** tag also pushes that tag, but a tag push does not trigger `publish.yml`, so exactly one run starts. That single trigger is the point: two simultaneous runs race on the registry check (it can lag by well over 20 seconds) and the loser fails at `npm publish`.
- A release you wrote by hand keeps its own notes: the `release` job finds it and leaves it untouched rather than overwriting it with the `CHANGELOG.md` section.
- A release created by our own workflow uses `GITHUB_TOKEN`, which cascades nothing, so it cannot re-trigger this workflow.

Prereleases published through the Releases UI default to the `next` dist-tag. A dispatch has no such context and must name it explicitly.

### Re-run, backport or dry-run

**Actions → Publish to npm → Run workflow** with:

- `ref`: the tag, branch or SHA to publish (`v0.9.11`, `main`, a commit)
- `dry-run: true`: runs the whole gate plus `npm publish --dry-run`
- `stage: true`: stages for 2FA approval instead of publishing

Dispatch a failed publish again with the same `ref` once the cause is fixed — the `verify` gate re-checks the registry, so a version that did land stops the run instead of double-publishing.

### Prerelease

Version `0.10.0-beta.1` plus `dist-tag: next`. A prerelease with `latest` is rejected, and the GitHub Release is marked prerelease so it does not become "Latest".

### Recovery

|Symptom|Action|
|---|---|
|`verify` failed|Fix on `main`, then re-dispatch `publish.yml` with the same `ref`|
|`publish` failed after `verify` passed|Re-dispatch `publish.yml` with the same `ref`; if the version did land, the publish step is skipped and the run still finishes green|
|Package published, GitHub Release missing|Re-dispatch `publish.yml` with the same `ref` — publishing is skipped and the Release is created from the `CHANGELOG.md` section|
|Bumped and tagged, but publish failed|The tag exists; re-dispatch `publish.yml` with `ref: v<version>`|
|`npm error You cannot publish over the previously published versions`|Two publishes ran for one version within the registry's propagation delay (for example a dispatch right after publishing a Release). The first one published; the failed run is harmless — confirm with `npm view pi-hermes-memory version`|
|`403` from npm on publish|The trusted publisher is missing or does not allow `npm publish` — see [One-time setup](#one-time-setup-the-npm-trusted-publisher)|

## Runners

Everything runs on GitHub-hosted `ubuntu-latest`. Blacksmith is not an option for this repository, for two independent reasons:

1. **Blacksmith is limited to GitHub organizations** — ["not available for personal repositories"](https://docs.blacksmith.sh/introduction/quickstart). `chandra447/pi-hermes-memory` is owned by a personal user account, so its jobs cannot be scheduled on Blacksmith at all.
2. **Even in an org, the publish job must stay on GitHub-hosted runners.** npm's trusted publishing supports GitHub-hosted runners only — self-hosted runners (which is the class Blacksmith registers into) are explicitly unsupported — and provenance asks for a cloud-hosted runner too. That is the whole mechanism that lets this repo publish without an `NPM_TOKEN`.

Cost is not a factor either way: Actions on public repositories is free, including the per-minute platform charge introduced in 2026. Blacksmith is a paid service with a 3,000 min/month free tier, and its wins — ~2× faster CPUs, 4× faster caches — would trim a ~3-minute test job.

If the repo later moves into a GitHub organization and CI wall-clock becomes a real cost, the split would be: `ci.yml` jobs on `blacksmith-2vcpu-ubuntu-2404`, `publish.yml` untouched on `ubuntu-latest`. Note that transferring the repo would require re-pointing the npm trusted publisher and that `package.json`'s `repository` URL must keep matching (case-sensitive) for provenance.

## Verifying a release

```bash
npm view pi-hermes-memory version dist-tags
npm audit signatures           # verifies registry + provenance attestations
gh release view v0.9.11
pi install npm:pi-hermes-memory
```

## Known gap

`CHANGELOG.md` stops at `0.9.4`; releases `0.9.5`–`0.9.10` exist only as GitHub Releases. `release.yml` keeps the file current from here on, but those six sections still need backfilling by hand if the changelog file matters to you.

## Reference

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
- [Staged publishing](https://docs.npmjs.com/staged-publishing)
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)
- [Pi Packages docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/packages.md)
