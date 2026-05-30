---
name: roadmap-planner
description: Create phase-based development roadmaps with realistic sprint planning, milestones, and timeline estimates. Use when the user asks for a roadmap, sprint plan, milestones, timeline, "when can we ship", or wants to break a project into phases. Complements PRD (what) and Architecture (how) — roadmap is "when & in what order".
metadata:
  version: 2
  created: "2026-05-19"
  updated: "2026-05-19"
  changelog: "v2 — Genericized examples; removed Flutter/tarot-specific bias from procedure body. Concrete example moved to dedicated section."
---

# Roadmap Planner — Phase-Based Development Plan Skill

Use this skill when the user needs a development timeline, phase breakdown, sprint plan, or "when can we ship this" answer.

## When to Use

- "Roadmap yaz" / "roadmap çıkar"
- "Sprint plan"
- "Milestones"
- "Timeline"
- "Faz planı"
- "Ne zaman bitirebiliriz?"

**NOT for:**
- Feature definition (use `prd-writer`)
- Tech decisions (use `project-architect`)

## Procedure

### Phase 1 — Context Gathering

Önce mevcut dokümanları oku:
- `docs/PRD.md` (feature listesi)
- `docs/ARCHITECTURE.md` (teknik bağlam)
- `docs/PLANNING-LOG.md` (kısıtlar)

Eksik olanları sor:
- Team size (solo / 2-3 kişi / takım)?
- Heftada kaç saat çalışabilir? (full-time / part-time / weekend)
- Hard deadlines var mı? (yatırımcı toplantısı, store launch, kişisel)
- Geçmiş benzer proje tecrübesi var mı?
- Stack & platform (web / mobile / backend / data)?

### Phase 2 — Roadmap Structure (Generic Template)

Aşağıdaki **generic** şablonu mevcut projeye göre uyarla. `<placeholder>`'ları gerçek isimlerle doldur.

```markdown
# <Project Name> — Roadmap

**Owner:** <kim>
**Status:** Active
**Last updated:** <tarih>
**Total estimated duration:** <N hafta / N ay>

## 0. Assumptions
- Team: <solo / N kişi> + AI partner
- Capacity: <X> hours/week
- Skill level: <X>
- Stack: <Y>
- Platform target: <web / mobile / backend / data / cross>

## Phase Overview

```
Faz 0 — Foundation       (1-2 hafta)  ← Tooling, scaffold, CI
Faz 1 — MVP Core         (4-6 hafta)  ← İlk çalışan ürün
Faz 2 — Polish & Launch  (2-3 hafta)  ← Beta, store/marketplace
Faz 3 — Soft Launch      (2 hafta)    ← Limited release
Faz 4 — Scale            (kalıcı)     ← Genişleme
```

## Faz 0 — Foundation

**Goal:** Profesyonel altyapı + ilk "hello world" çıktısı

**Duration:** 1-2 hafta (~20-40 saat)

**Deliverables:**
- [ ] Repo scaffold (klasör yapısı + README'ler + .gitignore)
- [ ] CI pipeline (lint, test, build)
- [ ] Dev environment çalışıyor (local run)
- [ ] İlk ADR'ler yazıldı
- [ ] Domain registered, secrets bucket kuruldu

**Sprints:**

### Sprint 0.1 (Hafta 1) — Setup
- [ ] Day 1-2: Repo scaffold script çalıştır, klasörleri kur
- [ ] Day 3-4: Toolchain (SDK / runtime) kur, "hello world" çıktısı al
- [ ] Day 5: CI workflow'ları yaz
- [ ] Day 6-7: Initial commit, branch protection ayarla

### Sprint 0.2 (Hafta 2) — Foundation Detail
- [ ] CI'da test + build pass eden boş app
- [ ] İlk content / config / seed data versiyon
- [ ] Build/export scripts çalışır halde

**Exit criteria:** `git push` → CI green → build artefakt → hedef ortamda çalışır.

## Faz 1 — MVP Core

**Goal:** Tek niş / tek hedef kitle, çekirdek feature çalışan ürün

**Duration:** 4-6 hafta

**Deliverables:**
- [ ] Core domain layer + tests
- [ ] <N> primary features çalışır (PRD'den)
- [ ] Persistence katmanı (yerel / cloud)
- [ ] Temel UI/UX akışı
- [ ] Tema + iconography
- [ ] Primary dil tam, secondary dil placeholder

**Sprints (örnek bölümleme):**

### Sprint 1.1 — Domain Layer
- [ ] Entity'leri tanımla
- [ ] Core services + tests
- [ ] Edge case coverage

### Sprint 1.2 — Data Layer
- [ ] Persistence (local DB / API)
- [ ] Config / preferences

### Sprint 1.3 — UI Skeleton
- [ ] Main screen layout
- [ ] Primary widget'lar
- [ ] Tema tokens applied

### Sprint 1.4 — Primary Flow
- [ ] User happy path çalışır end-to-end
- [ ] Persist + retrieve

### Sprint 1.5 — Secondary Feature
- [ ] PRD'de "Must Have" diye işaretli kalan feature
- [ ] Integration tests

### Sprint 1.6 — Polish & Internal Beta
- [ ] Bug bash
- [ ] Performance pass
- [ ] Internal release / staging deploy
- [ ] 5 beta tester feedback

**Exit criteria:** Beta tester'lar ürünü kullanır + "useable" diyor.

## Faz 2 — Polish & Launch Prep

**Goal:** Production-ready ürün

**Duration:** 2-3 hafta

**Deliverables:**
- [ ] All NFRs met (performance, accessibility, offline/online)
- [ ] Localization complete
- [ ] Store / marketplace assets (icon, screenshots, description)
- [ ] Privacy policy, terms of service
- [ ] Sentry / equivalent observability live
- [ ] Analytics + crash reporting
- [ ] Monetization integrated (kapalı veya açık mod)
- [ ] Promo video / GIF
- [ ] Launch checklist tamamlandı

## Faz 3 — Soft Launch

**Goal:** Limited geographic / audience release, feedback loop

**Duration:** 2 hafta (+ data collection)

**Activities:**
- [ ] Production release (sınırlı pazar / dil)
- [ ] Beta community feedback (ilgili community'ler)
- [ ] Social media launch posts
- [ ] İlk 3 user complaint üzerine iterate

**Metrics gate:**
- 50+ aktif kullanıcı in 2 weeks
- Crash-free rate > 99%
- Day-1 retention > 30%

## Faz 4 — Scale (Ongoing)

**Themes (her quarter):**
- Q1: Yeni platform / channel
- Q2: 2nd niş / segment
- Q3: Otomasyon (content pipeline, dağıtım)
- Q4: Monetization optimize

## Velocity Calibration

Bu plan **TEORIK**. Gerçek velocity sprint sonrasında ayarlanır:

| Sprint | Planned | Actual | Notes |
|---|---|---|---|
| 0.1 | 20h | TBD | TBD |

Her sprint sonunda bu tabloyu güncelle. Variance > %30 ise plan revize.

## Risk-Adjusted Timeline

| Senaryo | Toplam süre |
|---|---|
| Best case (skill öğrenme hızlı, blocker yok) | 12 hafta |
| Realistic (ortalama hızda) | 16 hafta |
| Pessimistic (öğrenme yavaş, 2 blocker) | 22 hafta |

## Dependencies & Blockers

| Dependency | Status | Owner | ETA |
|---|---|---|---|
| Toolchain install | Done | Sen | - |
| Domain choice | Pending | Sen | Bu hafta |
| Store / hosting account | Pending | Sen | Faz 2 başı |

## Milestone Calendar (Approximate)

| Milestone | Target | Status |
|---|---|---|
| M0 — Repo scaffold ready | Hafta 2 sonu | ⏳ |
| M1 — First build runs locally | Hafta 4 sonu | ⏳ |
| M2 — Core flow works end-to-end | Hafta 9 sonu | ⏳ |
| M3 — Internal beta | Hafta 10 sonu | ⏳ |
| M4 — Soft launch | Hafta 13 sonu | ⏳ |
| M5 — Second platform | Hafta 22 sonu | ⏳ |
| M6 — 2nd niche / segment | Hafta 30 sonu | ⏳ |

## Definition of Done (Project-wide)

Her sprint task'ı "done" kabul edilmeden önce:
- [ ] Code written
- [ ] Tests pass
- [ ] PR reviewed (self or AI)
- [ ] Merged to main
- [ ] CI green
- [ ] Doc updated (if behavior change)
- [ ] CHANGELOG entry (if user-visible)
```

### Phase 3 — Estimation Rules

- **Solo dev part-time (10h/wk)**: küçük feature 1-2 hafta, orta 2-4 hafta, büyük 4-8 hafta
- **Learning tax**: ilk kez kullanılan framework için süreyi 1.5x yap
- **Integration tax**: 3+ servisin entegrasyonu var ise +%30 zaman ekle
- **"Polish & test" zamanı**: dev süresinin %30-50'si kadar
- **Buffer**: her faz sonunda 1 hafta buffer bırak

### Phase 4 — Output

- Dosya yolu: `docs/ROADMAP.md`
- Markdown formatı + ASCII Gantt-like chart
- Hafta numaraları, tarih değil (esneklik için)
- Velocity tablo'su boş başlat, sprint sonlarında doldurulur

## Concrete Example (illustrative only)

Aşağıdaki **örnek** bir Flutter mobile tarot uygulamasına ait. Skill'i farklı stack'lerde kullanırken bu örneği taklit etme — kendi domain'inin entity'leri ve manifest'leriyle doldur.

```
Faz 1 — MVP Core (örnek bölümleme, Flutter projesi)
  1.1 Domain Layer        Card / Deck / Reading entity, ShuffleService, SlotRenderer, ComboDetector + tests
  1.2 Data Layer          JsonDeckLoader, SqliteReadingRepository, SharedPreferences wrapper
  1.3 UI Skeleton         Main screen, Card widget + flip animation, Reading mode selector, Theme tokens
  1.4 Reading Flow        Draw cards interaction, Reading view with positions, Save to history
  1.5 Share Feature       ShareCardRenderer, Watermark + deep link, share_plus integration
  1.6 Polish & Beta       Bug bash, perf pass, Internal Play track upload, 5 tester feedback
```

Eğer projen web ise: `1.3` Next.js page'ler + Tailwind tokens olur.
Eğer projen backend ise: `1.3` controller/route layer + OpenAPI spec olur.
Eğer projen data pipeline ise: `1.3` orchestration (Airflow/Dagster) + first DAG olur.

## Pitfalls

- ❌ "2 günde yaparız" optimizmi → her zaman 2-3x süre koy
- ❌ Buffer atlamak → bir slip her şeyi çökertir
- ❌ "Faz 2'de düşünürüz" sonsuz erteleme → her fazın exit criteria'sı net
- ❌ Soft launch'sız direkt production → feedback loop kaybı
- ❌ Platform 2'yi platform 1 ile paralel planlamak → ekstra 30% zaman, ayrı sprint
- ❌ Localization'ı sonsuz erteleme → MVP'de en az 1 secondary dil
- ❌ Generic skill'i belirli bir stack varsayımıyla yazmak → bu skill stack-agnostik, prosedür gövdesinde framework adı geçmez

## Verification

- [ ] Her fazın exit criteria'sı var mı?
- [ ] Her sprint'in deliverable listesi var mı?
- [ ] Best/realistic/pessimistic 3'lü tahmin var mı?
- [ ] Dependencies tablosu güncel mi?
- [ ] Velocity tablo'su sprint sonrası doldurulmak üzere hazır mı?
- [ ] Milestone calendar tarih içeriyor mu (hafta numarası OK)?
- [ ] Definition of Done tanımlı mı?
- [ ] Stack'e özel terim varsa "Concrete Example" bölümüne taşındı mı (prosedüre değil)?

## Example Triggers

User: "Ne zaman bitirebiliriz?" → Tam roadmap çıkar, ayrıca best/realistic/pessimistic ver.

User: "Sprint planı" → Faz 1 detayını derinleştir, diğer fazları üst seviyede tut.

User: "Faz 2 ne içerecek?" → Sadece Faz 2'yi derinleştir, geri kalanı varolanı koru.
