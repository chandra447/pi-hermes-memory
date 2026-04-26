# Publishing to pi.dev/packages

## How pi.dev/packages Works

The [package gallery](https://pi.dev/packages) automatically displays any npm package tagged with the keyword `pi-package`. There is no manual submission — you publish to npm, and pi.dev picks it up.

## What We Need

### 1. Update `package.json` with Pi manifest

Current state:
```json
{
  "name": "pi-hermes-memory",
  "keywords": []  // missing pi-package keyword
  // no "pi" manifest
}
```

Target state:
```json
{
  "name": "pi-hermes-memory",
  "version": "0.1.0",
  "description": "Persistent memory and self-directed learning loop for Pi — ported from the Hermes agent harness.",
  "keywords": [
    "pi-package",
    "pi-extension",
    "memory",
    "learning",
    "hermes"
  ],
  "files": [
    "src",
    "README.md",
    "LICENSE"
  ],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/chandra447/pi-hermes-memory"
  },
  "pi": {
    "extensions": ["./src/index.ts"],
    "image": "https://raw.githubusercontent.com/chandra447/pi-hermes-memory/main/docs/assets/hermes-memory-preview.png"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  }
}
```

Key changes:
- `"keywords": ["pi-package", ...]` — **required** for pi.dev listing
- `"pi": { "extensions": ["./src/index.ts"] }` — tells Pi where the entry point is
- `"files": ["src", "README.md", "LICENSE"]` — only publish what's needed
- `"peerDependencies"` — Pi provides the API, no runtime deps needed
- `"pi": { "image": "..." }` — optional preview image for the gallery

### 2. npm account setup

```bash
# Login to npm (create account at npmjs.com if needed)
npm login

# Verify you're logged in
npm whoami
```

### 3. Publish

```bash
# Dry run first — verify what gets published
npm publish --dry-run

# Publish as public (scoped packages default to restricted)
npm publish --access public
```

### 4. Verify

After publishing:
1. Check `https://www.npmjs.com/package/pi-hermes-memory`
2. Check `https://pi.dev/packages` — should appear within minutes
3. Test install: `pi install npm:pi-hermes-memory`

## Post-Publish

### Installation becomes one command

Before (git):
```bash
pi install git:github:chandra447/pi-hermes-memory
```

After (npm):
```bash
pi install npm:pi-hermes-memory
```

### Update README installation instructions

Replace:
```
pi install github:chandra447/pi-hermes-memory
```

With:
```
pi install npm:pi-hermes-memory
```

Keep the git option as an alternative.

### Version updates

```bash
# Patch (0.1.0 → 0.1.1): bug fixes
npm version patch && npm publish

# Minor (0.1.0 → 0.2.0): new features, backwards compatible
npm version minor && npm publish

# Major (0.1.0 → 1.0.0): breaking changes
npm version major && npm publish
```

## Checklist

- [ ] Update `package.json` with `pi` manifest and `pi-package` keyword
- [ ] Remove `devDependencies` that shouldn't ship (keep `peerDependencies` only)
- [ ] Add `"files"` field to control what npm includes
- [ ] Create npm account if needed
- [ ] `npm login`
- [ ] `npm publish --dry-run` — verify contents
- [ ] `npm publish --access public`
- [ ] Verify on npmjs.com
- [ ] Verify on pi.dev/packages
- [ ] Test `pi install npm:pi-hermes-memory`
- [ ] Update README installation instructions
- [ ] Add demo screenshot/image for pi.dev gallery (optional but recommended)
- [ ] Tag release: `git tag v0.1.0-npm && git push --tags`

## Reference

- [Pi Packages docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/packages.md)
- [pi.dev/packages](https://pi.dev/packages)
- [npm search for pi-package](https://www.npmjs.com/search?q=keywords%3Api-package)
- Example: [@samfp/pi-memory](https://www.npmjs.com/package/@samfp/pi-memory) — 6k downloads, same pattern
