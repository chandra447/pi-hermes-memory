---
name: release-prepper
description: Prepare a clean, professional release — bump version, update CHANGELOG, write release notes, tag the commit, and produce a pre-flight checklist. Use when the user says "release", "ship it", "deploy", "yeni versiyon çıkart", "v1.0 hazırla", or wants to follow Keep a Changelog + SemVer discipline. Stack-agnostic; works for web, mobile, backend, libraries, monorepos.
metadata:
  version: 2
  created: "2026-05-19"
  updated: "2026-05-19"
  changelog: "v2 — Genericized: tarot/Flutter examples moved to a dedicated 'Concrete Example' section. Procedure body uses <placeholder>s for manifest files and version fields."
---

# Release Prepper — Clean Release Discipline Skill

Use this skill when preparing any release (alpha, beta, production, hotfix).

## When to Use

- "Yeni sürüm çıkart" / "release et"
- "v1.0 hazırla"
- "Store'a / production'a yükleyelim"
- "CHANGELOG güncelle"
- "Tag at"
- Hotfix prep

## Procedure

### Phase 1 — Pre-flight Audit

Önce repo durumunu kontrol et:

```
1. git status              → working tree clean mi?
2. git log <last-tag>..HEAD → ne değişmiş?
3. CI status               → main branch green mi?
4. CHANGELOG.md            → unreleased changes var mı?
5. Open issues/PRs         → release-blocker var mı?
```

Eğer herhangi biri kırmızıysa: kullanıcıya söyle, release'i ertele.

### Phase 2 — Version Bump (SemVer)

```
MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]

Major (X.0.0)  → Breaking change (kullanıcı için bozucu)
Minor (1.X.0)  → Yeni feature, geriye uyumlu
Patch (1.0.X)  → Bug fix only

Prerelease örnekleri: 1.0.0-alpha.1, 1.0.0-beta.3, 1.0.0-rc.1
```

**Monorepo'da:** Her app + package'in ayrı semver'i. Tag format:
- `<package>@v1.2.3`
- `<app>@v0.5.0`

Tek-paket repo'da: `v1.2.3`

**Version dosyaları (stack'e göre değişir, hepsini güncelle):**
- Node.js / npm: `package.json` → `"version"`
- Python: `pyproject.toml` veya `__version__`
- Rust: `Cargo.toml` → `[package].version`
- Flutter/Dart: `pubspec.yaml` → `version`
- Mobile (native): Android `versionCode/versionName`, iOS `CFBundleVersion`/`CFBundleShortVersionString`
- Go: git tag yeterli, ama internal `version.go` varsa güncelle
- Manifest yoksa: git tag tek kaynak

### Phase 3 — CHANGELOG.md Update

**Keep a Changelog** formatı kullan: https://keepachangelog.com

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Feature in development

## [1.2.0] - 2026-05-19
### Added
- <user-visible feature> (#42)
- <i18n: new locale supported> (#38)

### Changed
- <behavior change visible to user> (#45)

### Fixed
- <bug fix> (#41)

### Deprecated
- <will be removed in v2.0>

### Removed
- <legacy endpoints>

### Security
- Updated dependencies to patch CVE-YYYY-XXXX
```

**Section'lar (sıra önemli):**
1. **Added** — Yeni feature
2. **Changed** — Mevcut davranış değişti
3. **Deprecated** — Kullanımdan kalkacak
4. **Removed** — Silindi
5. **Fixed** — Bug fix
6. **Security** — Güvenlik fix

### Phase 4 — Release Notes (User-Facing)

CHANGELOG technical, release notes user-facing. App store / GitHub release / blog post / email içine girer.

**Generic template:**

```markdown
# <Product Name> v<X.Y.Z>

**✨ Yeni Bu Sürümde**

- <Feature 1, kullanıcı dilinde>
- <Feature 2>

**🔧 İyileştirmeler**
- <Performance / UX iyileştirmesi>
- <Bug fix, kullanıcının görebileceği şekilde>

**🙏 Teşekkürler**
- <Beta testers / contributors>

---

Bug bulduysan: <link>
Görüşler: <social>
```

**Kurallar:**
- Emoji kullan (store'da göz yakalar) — eğer marka tonuna uyuyorsa
- Teknik jargon NO ("refactored shuffle algorithm" → kullanıcı umursamaz)
- Hangi feature kimin için önemli, sırala
- Internal change'ler (CI, refactor) release notes'a girmez — CHANGELOG'da kal

### Phase 5 — Pre-Release Checklist

Aşağıdakileri sırayla kontrol et:

```markdown
## Release Checklist — v<X.Y.Z>

### Code
- [ ] All PRs merged
- [ ] main branch CI green
- [ ] No critical TODOs in code
- [ ] No `print()` / `console.log()` left in prod paths
- [ ] No commented-out blocks

### Tests
- [ ] Unit tests pass
- [ ] Integration / widget tests pass
- [ ] Manual smoke test in production-like environment

### Versioning
- [ ] Manifest version bumped (`<manifest file>`)
- [ ] Platform-specific build numbers incremented (if applicable)
- [ ] CHANGELOG.md updated
- [ ] Migration guide for breaking changes (if any)

### Documentation
- [ ] README.md current
- [ ] Release notes written
- [ ] API docs regenerated (if applicable)

### Assets (if user-facing)
- [ ] App icon / favicon resolutions all present
- [ ] Splash screen / loading state present
- [ ] Store / marketing screenshots updated (if UI changed)
- [ ] Promo video/GIF (if marketing push)

### Stores / hosting (if applicable)
- [ ] Build uploaded to relevant store(s) / artifact registry
- [ ] Listing description in all supported languages
- [ ] Privacy policy URL valid
- [ ] Content rating / age verified

### Backend (if applicable)
- [ ] Database migrations tested
- [ ] Env vars/secrets in production
- [ ] Rollback plan documented
- [ ] Feature flags configured

### Monitoring
- [ ] Release tag prepared in error tracker (Sentry, etc.)
- [ ] Analytics version property set
- [ ] Crash / error threshold alert configured

### Communication
- [ ] Social media posts scheduled
- [ ] Beta testers notified
- [ ] Community announcement drafted

### Tag & Deploy
- [ ] Commit changelog + version bump
- [ ] Annotated tag created
- [ ] Tag pushed
- [ ] CI builds release artifact
- [ ] Promoted from staging → production
```

### Phase 6 — Tag + Push

```bash
# Final commit (CHANGELOG + version bump)
git add CHANGELOG.md <manifest file(s)>
git commit -m "chore(release): v<X.Y.Z>"

# Annotated tag (good practice — has metadata)
git tag -a "<prefix>@v<X.Y.Z>" -m "<Product Name> v<X.Y.Z> — <short headline>"

# Push
git push origin main
git push origin "<prefix>@v<X.Y.Z>"
```

### Phase 7 — Post-Release

- [ ] GitHub release oluştur (release notes ile)
- [ ] CHANGELOG'da [Unreleased] bölümünü tekrar boşalt
- [ ] Sentry / error tracker'da release tagle
- [ ] Sosyal medya postlarını schedule et / gönder
- [ ] 24 saat boyunca crash rate / error rate izle
- [ ] Eğer kritik bug çıkarsa hotfix yolunu hazır tut

## Concrete Example (illustrative — Flutter mobile app)

Aşağıdaki örnek bir Flutter mobil tarot uygulaması için. Farklı stack'lerde direkt kopyalama — sadece pattern'i göster.

```bash
# Manifest dosyaları
# pubspec.yaml:    version: 1.2.0+12
# android/app/build.gradle: versionCode 12 / versionName "1.2.0"
# ios/Runner.xcodeproj: CFBundleVersion 12 / CFBundleShortVersionString 1.2.0

git add CHANGELOG.md pubspec.yaml android/app/build.gradle ios/
git commit -m "chore(release): v1.2.0"
git tag -a "dev-tarot@v1.2.0" -m "Dev Tarot v1.2.0 — Sosyal Paylaşım + TR"
git push origin main dev-tarot@v1.2.0
```

Release notes örneği (Türkçe, mobil app store için):

```markdown
# Dev Tarot v1.2.0

**🎴 Yeni Bu Sürümde**

✨ **Sosyal Paylaşım**: Çekilişlerini artık Instagram Story'e tek tıkla paylaşabilirsin
🌍 **Türkçe Desteği**: App tamamen Türkçe!

**🔧 İyileştirmeler**
- Kart döndürme animasyonu daha akıcı
- Geçmiş ekranı çökme düzeltildi
```

Farklı stack örnekleri:
- **Node.js library**: manifest = `package.json`, tag = `v1.2.0`, GitHub release + `npm publish`
- **Python package**: manifest = `pyproject.toml`, tag = `v1.2.0`, PyPI upload (`twine upload dist/*`)
- **Web app**: manifest = `package.json`, tag = `v1.2.0`, deploy via Vercel/Cloudflare/Fly preview → prod promotion
- **Monorepo**: `<package>@v1.2.0` per-package tag, Changesets gibi tool yardımcı olabilir

## Pitfalls

- ❌ CHANGELOG güncellemeden tag → "ne değişti?" sorusu cevapsız
- ❌ Patch'i Minor diye bumplamak → SemVer kontratını kırarsın
- ❌ Release notes'a "refactored internal X" yazmak → kullanıcı bunu umursamaz
- ❌ Tag'i sonradan force-push'lamak → CI/CD pipelines kırılır
- ❌ Test atlayıp acele release → her zaman geri tepiyor
- ❌ Store screenshot'larını güncellemiyor olmak → reject edilir
- ❌ "Hotfix" deyip aslında feature push'lamak → SemVer'a aykırı
- ❌ Generic skill'i stack-spesifik manifest varsayımıyla yazmak → bu skill stack-agnostik

## Verification

- [ ] CHANGELOG güncel mi (en üstte yeni versiyon var mı)?
- [ ] Version bump SemVer'a uygun mu?
- [ ] Tag formatı doğru mu?
- [ ] Release notes user-friendly mi (jargon yok)?
- [ ] Pre-flight checklist'in TÜM kutucukları işaretli mi?
- [ ] Rollback planı var mı?
- [ ] CI green mi push'tan önce?
- [ ] Stack'e özel manifest dosyaları (`package.json`, `pubspec.yaml`, etc.) hepsi güncel mi?

## Example Triggers

User: "v1.0 hazırla" → Tam release prep (changelog + notes + checklist + tag).

User: "Sadece changelog güncelle" → Sadece Phase 3.

User: "Hotfix at" → Phase 1 + 2 (patch bump) + 3 + 5 + 6, skip marketing.

User: "Bu commit'leri changelog'a yaz" → `git log <last-tag>..HEAD` ile commit'leri al, conventional commit prefix'lerine göre kategorile (feat:→Added, fix:→Fixed, vb).
