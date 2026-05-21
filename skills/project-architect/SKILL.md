---
name: project-architect
description: Produce professional-grade ARCHITECTURE.md documents for software projects. Use when the user requests a system architecture, technical design document, infrastructure plan, or wants to scaffold a new project's foundation. Covers mobile, web, backend, data pipelines, and multi-app/monorepo projects. Adapts depth (Lite vs Full) to team size and project ambition.
metadata:
  version: 2
  created: "2026-05-19"
  updated: "2026-05-19"
  changelog: "v2 — Added Lite (8-section) vs Full (17-section) modes. Added Phase 5 PLANNING-LOG handoff so downstream skills (prd-writer, roadmap-planner) don't re-ask the same questions."
---

# Project Architect — Professional Architecture Document Skill

Use this skill whenever the user asks for an architecture document, system design, technical foundation, or wants to plan how a new project will be built.

## When to Use

- "Bana mimari çıkar" / "draw the architecture"
- "Project foundation plan" / "system design"
- "Hangi tech stack'ı kullanmalıyım?" + birden fazla bağlamlı soru
- "Multi-app / monorepo design"
- "ARCHITECTURE.md yaz"
- New greenfield project planning
- Refactoring an existing project into a cleaner structure

## Procedure

### Phase 1 — Discovery (clarifying questions)

NEVER skip this. Ask 5-10 targeted questions BEFORE writing anything. Group by concern:

**Product context**
- Who is the user / niche?
- Single product or family of products?
- Target platforms (web/mobile/desktop)?
- Online/offline requirements?
- Monetization model?

**Technical context**
- Existing code/assets to migrate?
- Team size (solo / small / large)?
- Skill background (which langs/frameworks)?
- Budget (free tier / paid services OK)?
- Timeline (weeks / months / years)?

**Scale & constraints**
- Expected user base (10 / 10K / 1M)?
- Multi-language / multi-region?
- Compliance (GDPR / HIPAA / app store policies)?
- Real-time requirements?

If user already provided context (previous docs like PLANNING-LOG.md), READ those first and only ask gaps.

### Phase 2 — Pick Mode (Lite vs Full)

Discovery cevaplarına bakarak mode seç:

| Sinyal | Mode |
|---|---|
| Solo dev, hobby/side project, MVP < 12 hafta, tek platform | **Lite** (8 bölüm) |
| Solo dev, ciddi ürün hedefi, multi-platform veya multi-product | **Full** (17 bölüm) |
| Takım (2+), production hedef, ARR/revenue planı | **Full** (17 bölüm) |
| Refactor / migration on existing codebase | **Full** (17 bölüm) |
| Library / SDK / single-purpose tool | **Lite** (8 bölüm) |

Mode'u kullanıcıya **söyle**: "Sinyallere bakınca Lite mode öneriyorum — solo + MVP. Full ister misin?" Karar onun.

### Phase 3a — Architecture Document Sections (Lite mode)

Lite mode 8 bölümden oluşur — solo / hobby / first-time projeler için:

1. **Architectural Principles** — 5-7 ilke, kısa
2. **High-level System Diagram** — Tek bir ASCII diagram, katmanlar
3. **Repo / Folder Structure** — Klasör tree, her satır yorumlu
4. **Tech Stack & Why** — Dil, framework, kütüphane seçimi + gerekçe
5. **Critical Path Flow** — Projenin ana feature'ı için end-to-end akış
6. **Test Strategy** — Minimum: hangi katmanda test, coverage hedefi
7. **Cost Structure** — Aylık maliyet tablosu (MVP / launch)
8. **Open Questions / Next Steps** — Architect onayından sonra ne gelir

### Phase 3b — Architecture Document Sections (Full mode)

Full mode 17 bölüm:

1. **Architectural Principles** — 8-12 ilke, "ne yaptığını" değil "neden böyle" açıklar
2. **High-level System Diagram** — ASCII art ile katmanlar (user → app → core → data → cloud)
3. **Repo / Folder Structure** — Tüm dosya/klasör tree, her satır yorumlu
4. **Internal App Architecture** — Clean Architecture / Hexagonal / MVC etc. layers
5. **State Management** — Hangi pattern, neden seçildi
6. **Data Model** — Entity diyagramları
7. **Critical Path Flow** — Projenin "kalp" feature'ı için end-to-end pipeline
8. **Build & Release Pipeline** — Local → CI → Release
9. **Environment & Secret Management** — `.env`, secrets bucket
10. **Test Strategy** — Test pyramid, coverage hedefleri
11. **Cost Structure** — Aylık maliyet tablosu (MVP / launch / scale)
12. **Phased Activation** — Hangi katman ne zaman devreye girer
13. **Professional Discipline Checklist** — ADR, CHANGELOG, semver, branch protection
14. **Replication / Templating** — Yeni instance/niş eklemek nasıl?
15. **Domain Boundaries** — App-specific vs shared vs content
16. **Risks & Tradeoffs** — Her ana kararın downside'ı
17. **Open Questions / Next Steps** — Architect onayından sonra ne gelir

### Phase 4 — Writing Guidelines

- **Markdown formatı**: GitHub-flavored Markdown, tablolar bol
- **Diyagramlar**: ASCII art kullan (Mermaid'e fallback yapma — her platformda render olmayabilir)
- **Maliyet tabloları**: Mutlaka rakam ver, "az / orta / çok" değil
- **Karar gerekçelendirmesi**: "X seçildi" yetmez, "Y yerine X seçildi çünkü..." de
- **Tradeoff açıkça yazılır**: Her kararın bir bedeli var, sakla
- **"Senior tech lead" tonu**: Profesyonel ama erişilebilir, jargon kullan ama anlamı açıkla
- **Tekrar etmek YOK**: Aynı bilgi 2 yerde varsa biri silinir veya cross-reference verilir
- **Uzunluk hedefi**:
  - Lite: 300-600 satır (10-25 KB)
  - Full: 800-1500 satır (35-60 KB)

### Phase 5 — Output + Handoff

**Output:**
- Dosya yolu: `docs/ARCHITECTURE.md` (proje kökünde)
- Tek dosya, başka split yok
- Sonunda "open questions" bölümü ile bitir → kullanıcı karar versin

**Discovery handoff (KRİTİK):**
Discovery aşamasında topladığın bağlamı `docs/PLANNING-LOG.md`'ye işle. Dosya yoksa oluştur. Bu sayede downstream skill'ler (`prd-writer`, `roadmap-planner`) aynı soruları tekrar sormaz.

Minimum PLANNING-LOG.md formatı:

```markdown
# <Project Name> — Planning Log

## Discovery Q&A — <YYYY-MM-DD>

### Product context
- Niche: ...
- Platforms: ...
- Monetization: ...

### Technical context
- Team size: ...
- Stack: ...
- Timeline: ...

### Confirmed decisions
| # | Decision | Date |
|---|---|---|
| D1 | <karar> | <tarih> |

### Open actions
- A1: <ne kalmış>
```

Eğer PLANNING-LOG zaten varsa, "## Discovery — <bugün>" başlığı altında **append** et, mevcut içeriği silme.

**Caller'a dönüş:**
Kısa özet (3-5 madde) + iki dosyanın yolu:
- `docs/ARCHITECTURE.md`
- `docs/PLANNING-LOG.md`

### Phase 6 — Follow-up Suggestions

Architecture bittikten sonra şunları öner:
1. `PRD.md` (product requirements) — prd-writer skill'i ile
2. `ROADMAP.md` (sprint plan) — roadmap-planner skill'i ile
3. İlk ADR (Architecture Decision Record) — adr-recorder skill'i ile
4. Repo iskelet scaffold

## Pitfalls

- ❌ Discovery phase'i atlamak → genel/jenerik mimari çıkar
- ❌ Mode seçmemek / Full'u solo dev'e dayatmak → 17 bölümün yarısı boş kalır
- ❌ Diyagram yerine sadece bullet list → görsel kayıp
- ❌ "Bunu sonra düşünürüz" yazmak → ya bölüm tam yazılır ya da çıkarılır
- ❌ Maliyet kısmında muğlak ifade → her zaman rakam
- ❌ Tradeoff'ları gizlemek → güven kaybı
- ❌ "İdeal" mimari sun → bağlam'a uygun mimari sun (solo dev'e enterprise pattern uygunsuz)
- ❌ Birden fazla output dosyası → ARCHITECTURE.md tek dosyadır, scope creep yapma
- ❌ Tech stack'ı kullanıcıya sormadan seçmek → her zaman discovery'de sor
- ❌ Discovery cevaplarını PLANNING-LOG'a yazmamak → sonraki skill'ler aynı soruları tekrar sorar

## Verification

Mimari iyi mi diye kontrol için:

- [ ] Mode (Lite/Full) bilinçli seçildi mi ve kullanıcıya söylendi mi?
- [ ] Lite'te 8 / Full'da 17 bölümün hepsi var mı (veya gerekçeli olarak atlandı mı)?
- [ ] Her diyagram ASCII art ile var mı?
- [ ] Repo yapısında her klasör için yorum var mı?
- [ ] Maliyet tablosu rakamlı mı?
- [ ] En az 3 tradeoff açıkça yazıldı mı (Full mode)?
- [ ] Cross-references çalışıyor mu (örn. "bkz. Section 4")?
- [ ] "Open questions" bölümü gerçekten kullanıcıdan cevap bekliyor mu?
- [ ] Lite: 300-600 satır / Full: 800-1500 satır mı?
- [ ] `docs/PLANNING-LOG.md` discovery cevaplarıyla güncellendi mi?

## Example Triggers

User says: "Yeni bir projeye başlıyorum, mimarisini çıkarır mısın?"
→ Skill devreye gir, Phase 1 discovery sorularıyla başla.

User says: "Bu Python projesi için Flutter mobil mimarisi nasıl olur?"
→ Mevcut Python kodunu OKU, sonra Phase 1 discovery yap. Multi-platform + migration → Full mode.

User says: "Küçük bir CLI tool yapacağım, mimari lazım mı?"
→ Lite mode öner. 8 bölüm yeterli.

User says: "ARCHITECTURE.md yaz"
→ Hiç soru sormadan başlama. Önce mevcut docs/PLANNING-LOG.md vb. dosyaları oku, sonra eksikleri sor.
