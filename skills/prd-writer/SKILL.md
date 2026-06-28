---
name: prd-writer
description: Write professional Product Requirements Documents (PRDs). Use when the user asks for a PRD, product spec, feature spec, requirements document, user stories, or wants to define what an app/feature should do (vs how it's built). Complements project-architect skill — PRD is "what & why", architecture is "how".
metadata:
  version: 2
  created: "2026-05-19"
  updated: "2026-05-19"
  changelog: "v2 — Frontmatter cleanup: non-standard fields (version/created/updated) moved under metadata per pi spec."
---
# PRD Writer — Product Requirements Document Skill

Use this skill whenever the user asks for product requirements, feature specifications, or wants to define what a product DOES (not how it's built).

## When to Use

- "PRD yaz" / "write a PRD"
- "Feature spec / requirements"
- "User stories"
- "Product definition"
- "MVP scope"
- "Bu app neyi yapacak?"

**NOT for:**
- Architecture / tech stack (use `project-architect` skill)
- Sprint planning / timeline (use `roadmap-planner` skill)

## Procedure

### Phase 1 — Discovery

Önce mevcut dokümantasyonu oku (varsa `PLANNING-LOG.md`, `ARCHITECTURE.md`). Sonra eksik kalan yerleri sor:

**Vision & Goals**
- Tek cümle: bu ürün ne yapıyor?
- Hedef kitle kim? (persona)
- 6 ayda başarı nedir? (1 metric)

**Problem & Solution**
- Hangi problemi çözüyor?
- Şu an insanlar nasıl çözüyor? (alternatives)
- Bizimki neden daha iyi? (differentiation)

**Scope & Constraints**
- MVP'de NE VAR? (must-have)
- MVP'de NE YOK? (out-of-scope) — bu kritik
- Hard constraints (offline, multi-lang, etc.)

### Phase 2 — PRD Sections (Standart Şablon)

```markdown
# <Product Name> — PRD

**Owner:** <kim>
**Status:** Draft / In Review / Approved
**Version:** 1.0
**Last updated:** <tarih>

## 1. TL;DR (One Paragraph Summary)
2-3 cümle. Ne, kim için, neden.

## 2. Problem Statement
- Pain point #1
- Pain point #2
- Mevcut çözümler ve eksikleri

## 3. Goals & Non-Goals
**Goals:** (3-5 madde)
- ...

**Non-Goals (MVP'de yok):** (3-5 madde)
- ...

## 4. Target Audience
**Primary persona:**
- Yaş, meslek, ilgi alanı, dil
- Günlük hayatı / "day in the life"
- App'i ne zaman, nerede, nasıl kullanır?

**Secondary persona (varsa):** ...

## 5. User Stories
Format: "As a <user>, I want <action>, so that <benefit>."

### Epic 1: <Theme>
- Story 1.1: ...
- Story 1.2: ...

### Epic 2: <Theme>
- ...

Her story için Acceptance Criteria yaz (Given/When/Then formatı).

## 6. Feature List (MVP)

| # | Feature | Priority | Effort | Notes |
|---|---|---|---|---|
| F1 | <ad> | Must / Should / Could | S/M/L | ... |

Priority sistem: MoSCoW (Must / Should / Could / Won't).
Effort: T-shirt sizing (XS/S/M/L/XL).

## 7. User Flow Diagrams
ASCII art ile critical path flow'ları:
- Onboarding
- Core action (e.g. "tarot okuma")
- Sharing / monetization

## 8. Functional Requirements
Her feature için:
- Inputs (kullanıcıdan ne alır)
- Behaviors (ne yapar)
- Outputs (ne döner)
- Edge cases (boş veri, network kapalı, vb.)

## 9. Non-Functional Requirements
- Performance: First paint < 2s, action latency < 200ms
- Offline: Hangi feature internet'siz çalışır?
- Accessibility: WCAG AA seviyesi mi?
- Localization: Hangi diller, RTL var mı?
- Privacy: Hangi veri toplanır, opt-out var mı?
- Security: Auth gerekli mi, data encryption?

## 10. Content & Data Requirements
- İçerik miktarı (örn. 78 kart × 4 dil = 312 metin)
- İçerik formatı (JSON, MD, DB)
- İçerik kaynağı (manuel, AI-generated, scraped)
- Update sıklığı

## 11. Success Metrics
**North star:** (tek metric)

**Supporting metrics:**
- DAU / MAU
- Day-7 retention
- Average session length
- Share rate
- Ad revenue per DAU

## 12. Monetization
- Free tier ne içerir?
- Paid tier(s) ne ekler?
- Pricing strategy (price anchor, geo-pricing)
- Conversion funnel

## 13. Risks & Open Questions
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ... | H/M/L | H/M/L | ... |

## 14. Out of Scope (Açıkça)
MVP'de NE OLMAYACAK — listele. Bu beklenti yönetimi için kritik.

## 15. Future Considerations
- Faz 2'de eklenebilecek özellikler
- Faz 3+ vizyonu
- "Sonra düşünürüz" listesi

## 16. Appendix
- Glossary
- Referanslar
- Competitive analysis (rakipler tablosu)
```

### Phase 3 — Writing Guidelines

- **User story formatı**: "As a / I want / So that" — sapma yok
- **Acceptance criteria**: Given/When/Then — her story için
- **MoSCoW priority**: Must > Should > Could > Won't (asla "high/medium/low" deme — belirsiz)
- **Out-of-scope açıkça yaz**: "Yapmayacağımız" şeyler kazaen yapılmamak için
- **Metrics önce, feature sonra**: Her feature'ı bir metrice bağla
- **Tabloyla zenginleştir**: Düz paragraf yorucu
- **Uzunluk hedefi**: 400-800 satır markdown (15-30 KB)

### Phase 4 — Output

- Dosya yolu: `docs/PRD.md`
- Status başlangıçta "Draft", kullanıcı onayından sonra "Approved"
- Sonunda kullanıcıya 3-5 onaylama sorusu sor (en kritik kararlar için)

## Pitfalls

- ❌ "How" sorularına girmek → bu PRD değil architecture, başka skill'e bırak
- ❌ Tüm feature'lara "Must" demek → MoSCoW priority anlamsızlaşır, max %60 Must olabilir
- ❌ User story yerine technical task yazmak → "Implement login button" ❌ vs "As a user I want to log in" ✅
- ❌ Out-of-scope'u atlamak → kapsama kaymadan ölür
- ❌ Success metrics olmadan PRD → "ne zaman kazandık" belirsiz
- ❌ Multiple persona'yı birleştirmek → her persona ayrı yazılır
- ❌ Localization, offline, accessibility'i unutmak → Non-functional req'de zorunlu

## Verification

- [ ] TL;DR 3 cümleden kısa mı?
- [ ] En az 1 primary persona detaylı mı?
- [ ] Her epic'in en az 3 user story'si var mı?
- [ ] Her story'nin acceptance criteria'sı var mı?
- [ ] MoSCoW priority dağılımı dengeli mi?
- [ ] Out-of-scope bölümü en az 5 madde mi?
- [ ] Success metrics ölçülebilir mi?
- [ ] Risks tablosunda mitigation var mı?
- [ ] Open questions kullanıcıya açıkça sorulmuş mu?

## Example Triggers

User: "PRD yaz" → Önce `ARCHITECTURE.md` ve `PLANNING-LOG.md` oku, sonra eksiklikleri sor.

User: "Bu app'in feature listesini çıkar" → PRD'nin Section 6'sından başla, ama tüm PRD bağlamını koru.

User: "User stories yaz" → Tam PRD'ye gerek yok, sadece Section 5'i detaylı doldur, geri kalanı atla.