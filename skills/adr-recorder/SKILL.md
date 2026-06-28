---
name: adr-recorder
description: Write Architecture Decision Records (ADRs) using the MADR template. Use when the user makes a significant technical decision (framework choice, database, deployment platform, architecture pattern, library selection) and wants it documented for future reference. ADRs answer "why did we do this?" months later.
metadata:
  version: 2
  created: "2026-05-19"
  updated: "2026-05-19"
  changelog: "v2 — Frontmatter cleanup: non-standard fields (version/created/updated) moved under metadata per pi spec."
---
# ADR Recorder — Architecture Decision Record Skill

Use this skill when a meaningful technical decision is made and should be documented for future reference.

## When to Use

- "Bu kararı dokümante et"
- "ADR yaz"
- "Niye X seçtik?" sorusunun cevabını kaydet
- Framework / library / platform / pattern seçimi yapıldığında
- "Geri dönmek zor olan" kararlar (DB schema, public API, etc.)
- Onaydan sonra mimari kararı çıkışı sonrası

**NOT for:**
- Küçük kod kararları (variable naming, etc.)
- Geçici kararlar / experiment'ler
- Bireysel tercihler (renk seçimi, vs.)

## Procedure

### Phase 1 — Sanity Check

Karar gerçekten ADR'lik mi? Kriterler:
- Geri dönmek pahalı (zaman/para/kod)
- Birden fazla seçenek vardı
- Birinden vazgeçildi
- 6 ay sonra "neden böyle yaptık?" sorusu sorulabilir

Eğer hayır: kullanıcıya söyle, ADR yerine `PLANNING-LOG.md`'ye satır eklemeyi öner.

### Phase 2 — ADR Numarası

`docs/adr/` klasöründe en yüksek numarayı bul, +1 al.
- Format: `0001-kebab-case-title.md`
- Örnek: `0001-flutter-over-react-native.md`

### Phase 3 — MADR Template (Markdown ADR)

```markdown
# <Numara>. <Karar Başlığı>

**Status:** Proposed / Accepted / Deprecated / Superseded by [<link>](...)
**Date:** YYYY-MM-DD
**Deciders:** <isimler>
**Tags:** <stack / data / infra / process>

## Context and Problem Statement

Neden bu kararı vermek zorundaydık? Sorunu 2-4 cümle açıkla.
"Şunu yapmak istedik ama X, Y, Z arasında seçim yapmak gerekti."

## Decision Drivers

Karar verirken neye baktık?
- Driver 1: ...
- Driver 2: ...
- Driver 3: ...

## Considered Options

1. **Option A** — kısa açıklama
2. **Option B** — kısa açıklama
3. **Option C** — kısa açıklama

## Decision Outcome

**Chosen option:** "Option B"

**Reasoning:** Neden bu seçildi (2-4 paragraf).

## Pros and Cons of the Options

### Option A
- ✅ Pro 1
- ✅ Pro 2
- ❌ Con 1
- ❌ Con 2

### Option B ← Chosen
- ✅ Pro 1
- ✅ Pro 2
- ✅ Pro 3
- ❌ Con 1 (kabul ediyoruz)

### Option C
- ✅ Pro 1
- ❌ Con 1
- ❌ Con 2

## Consequences

**Positive:**
- ...

**Negative (kabul edilen tradeoffs):**
- ...

**Neutral:**
- ...

## Implementation Notes

Bu kararı uygulamak için gereken adımlar (eğer ADR + immediate action):
- Step 1
- Step 2

## References

- [Link to related ADR]
- [Link to relevant article / docs]
- [Link to discussion]

## Validation / Revisit Trigger

Bu kararı ne zaman tekrar gözden geçirmeli?
- "Eğer X olursa ADR'i revize et"
- "6 ay sonra retrospect"
- "Çapraz-platform iOS perf metriği < hedef olursa"
```

### Phase 4 — Common ADR Topics

Proje boyunca tipik olarak yazılan ADR'ler:

**Tech stack:**
- 0001: Frontend framework seçimi (Flutter vs RN vs native)
- 0002: State management (Riverpod vs BLoC vs Provider)
- 0003: Database (SQLite vs Hive vs ObjectBox)
- 0004: Backend platform (Supabase vs Firebase vs custom)

**Architecture:**
- 00XX: Monorepo vs polyrepo
- 00XX: Clean Architecture vs MVVM
- 00XX: Content as JSON vs CMS

**Process:**
- 00XX: Conventional Commits adoption
- 00XX: Semver scheme (especially in monorepo)
- 00XX: CI/CD platform choice

**Infrastructure:**
- 00XX: Hosting (Cloudflare vs Vercel vs Fly)
- 00XX: Deep link service (Firebase Dynamic Links sunset → alternative)
- 00XX: Analytics (PostHog vs Mixpanel vs Firebase)

### Phase 5 — Output

- Dosya yolu: `docs/adr/<NNNN>-<kebab-title>.md`
- Tek dosya per karar
- Status başlangıçta "Accepted" (eğer onaylanmış karar) veya "Proposed" (tartışılıyor)
- `docs/adr/README.md` varsa onu da güncelle (index)

### Phase 6 — Optional: ADR Index

Eğer `docs/adr/README.md` yoksa, ilk ADR'le birlikte oluştur:

```markdown
# Architecture Decision Records

This directory contains ADRs (Architecture Decision Records) documenting significant technical decisions made in this project.

## What is an ADR?

An ADR captures a decision, its context, and consequences. The goal: 6 months from now, anyone can answer "why did we do this?" by reading the ADR.

## Status Lifecycle

- **Proposed** — Under discussion
- **Accepted** — Decided, in effect
- **Deprecated** — No longer recommended, but not yet replaced
- **Superseded** — Replaced by another ADR (link to new one)

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-flutter-over-react-native.md) | Flutter over React Native | Accepted | 2026-05-19 |
| ... | ... | ... | ... |
```

## Pitfalls

- ❌ Her küçük kararı ADR yapmak → ADR enflasyonu, kimse okumaz
- ❌ "Sonra yazarım" → asla yazılmaz, karar bağlamı kaybolur
- ❌ Sadece "chosen option" yazıp diğer opsiyonları atlamak → "neden A değil?" sorusu yanıtsız kalır
- ❌ Pros'u yazıp con'ları atlamak → dürüstlük kaybı, tradeoff gizlenir
- ❌ Eski ADR'i silmek → "Superseded by" link'ler kopar, history kaybolur
- ❌ Status alanını boş bırakmak → ADR live mı dead mi belirsiz
- ❌ ADR'leri 100+ satır yapmak → kimse okumaz, 30-80 satır ideal

## Verification

- [ ] ADR numarası doğru sıralı mı?
- [ ] Status alanı var mı?
- [ ] En az 2 alternatif değerlendirildi mi?
- [ ] Her option'ın pros + cons'ı var mı?
- [ ] Consequences negative'leri açıkça yazıldı mı?
- [ ] References bölümü var mı (en az 1)?
- [ ] Revisit trigger tanımlı mı?
- [ ] `docs/adr/README.md` index'i güncellendi mi?

## Example Triggers

User: "Flutter'ı seçtik, kaydet" → 0001 ADR yaz, MADR template ile.

User: "Supabase vs Firebase'i karşılaştırıp karar verelim" → Hemen ADR'in Proposed versiyonunu yaz, kullanıcı kararından sonra Accepted yap.

User: "Eski deep link kararı artık geçersiz" → İlgili ADR'i bul, Status'unu "Deprecated" yap. Yeni karar için yeni ADR aç, "Supersedes 00XX" referansını koy.