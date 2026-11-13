# Necessa: design system

> Minimal, calm and plain-spoken. Necessa is used by practice administrators, clinicians, compliance officers and executives, so the interface stays quiet, puts the evidence first and never uses engineering language. Colour carries meaning, not decoration.

## 1. Principles

1. **One typeface, few weights.** Geist everywhere (marketing included) at 400, 500 and 600. Geist Mono only for case numbers and codes.
2. **Flat and neutral.** Near-white canvas, hairline borders instead of shadows, an 8 px radius, one accent colour (indigo) for primary actions and links. No gradients, glows, sheens, glass or decorative backgrounds.
3. **Calm motion.** 150 to 200 ms fades and slides, skeleton loading, a one-time draw of the logo. Nothing loops. Everything honours `prefers-reduced-motion`.
4. **Plain language.** Customers read "Needs documentation", "Quote verified" and "Awaiting your review", never retrieval, model or pipeline terms. Engineering detail lives in `docs/ARCHITECTURE.md`, not in the product.
5. **Honest compliance wording.** "HIPAA-aligned safeguards", "designed to support your obligations". Never "HIPAA compliant" or any certification we do not hold.
6. **Status is never colour alone.** Every state pairs an icon with a label.

## 2. Brand

The mark is the **stem and the tick**: one stroke drawing an N whose last two strokes form a check (`src/components/brand/logo.tsx`). The wordmark is lowercase **necessa** in Geist SemiBold. Do not recolour the mark with verdict colours.

## 3. Colour tokens

Defined as CSS variables in `src/app/globals.css`, mapped to Tailwind with `@theme inline` (`bg-surface`, `text-muted`, `bg-met-soft` and so on). Dark mode uses the `.dark` class via `next-themes`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAFAFA` | `#0B0B0C` | Canvas |
| `--surface` | `#FFFFFF` | `#121213` | Cards, popovers |
| `--surface-2` / `-3` | `#F5F5F4` / `#ECECEA` | `#181819` / `#1F1F21` | Subtle fills, tracks |
| `--border` / `-strong` | `#E7E7E4` / `#D4D4D0` | `#252527` / `#353538` | Hairlines |
| `--fg` / `--fg-muted` / `--fg-subtle` | `#171717` / `#525252` / `#6B6B6B` | `#EDEDED` / `#A3A3A3` / `#8A8A8A` | Text (muted and subtle meet AA) |
| `--brand` | `#3E4BDB` | `#7D87FF` | Primary actions, focus, links |
| `--met` | `#0F7A55` | `#3CC48C` | Met, ready |
| `--insufficient` | `#A96600` | `#F0A53A` | Needs documentation, gaps, deadline warning |
| `--notmet` | `#B9372D` | `#F2685C` | Not met, overdue, destructive |
| `--chart-2` / `--chart-3` | `#5F9AA8` / `#8F86BF` | `#6FB2C2` / `#A99FE0` | Muted secondary chart series |

Each verdict colour has `-soft` (background) and `-fg` (text on soft) variants. The legacy `--ai-*` tokens and `.ai-gradient`, `.ai-border`, `.ai-sheen`, `.ai-text-shimmer`, `.ring-pulse` classes still exist so older callers keep working, but they are flattened to the single brand colour or turned off.

## 4. Elevation

`shadow-e1` and `shadow-e2` render as 1 px hairlines (`--border`, `--border-strong`), so existing cards are flat and bordered. `shadow-e3` is the only real shadow, used for floating layers (menus, dialogs, tooltips).

## 5. Layout and components

- App shell: a 244 px sidebar (collapses to 60 px), a 56 px top bar, content up to 1320 px. Navigation: Home, Cases, Denials & appeals, Ask Necessa, Policy library, Coverage lookup, Insights, Compliance, Team & settings. Operator consoles are not linked from the product.
- Primitives live in `src/components/ui` (button, inputs, overlays, data table, widgets, motion helpers) and `src/components/domain` (verdict badges, readiness ring, trust primitives).
- Trust primitives (`domain/trust.tsx`): `AiBadge` ("Suggested by Necessa"), `ConfidencePill`, `WhyButton` ("See basis"), `ReviewBadge`, `PhiMask` (masked until shown, and every reveal is recorded), `Provenance` ("quote verified"), `DecisionDisclaimer`.
- Charts (`components/charts`) are lazy-loaded and styled flat: hairline grids, thin lines, light area fills.

## 6. Accessibility

AA contrast for text and controls, visible focus rings, full keyboard support (⌘K search, `G`-prefixed navigation), tabular numerals for metrics and deadlines, and reduced-motion support throughout.
