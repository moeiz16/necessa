# Necessa — Design System

> Calm, precise, clinical. Necessa is a tool people use for hours a day to make decisions that affect patients' care, so the interface stays quiet and puts the evidence first. Color carries meaning, not decoration.

## 1. Brand

### Logo: "the stem and the tick"
One continuous stroke draws an **N** whose last two strokes form a **check**: the left stem is the *criterion*, and the descent plus the long ascent is the *verification*. The mark is drawn on a 32-unit grid with round caps and joins (`M9 23V9.5l7.6 9.8L24 8.5`, stroke 3.1).

| Asset | Where |
|---|---|
| `LogoMark` (`variant="badge"` / `"glyph"`), `LogoWordmark`, `Logo` lockup | `src/components/brand/logo.tsx`. The glyph uses `currentColor`; the badge fills with `currentColor` and knocks out the glyph |
| Favicon | `src/app/icon.svg` |
| Apple touch icon | `src/app/apple-icon.tsx` (generated) |
| Social card | `src/app/opengraph-image.tsx` (generated, 1200×630) |

Wordmark: lowercase **necessa**, Geist SemiBold, tracking −0.035em. Do not recolor the mark with verdict colors, and do not add a cross, stethoscope or shield. The checkmark already says "verified".

### Voice
Plain, specific, and honest about uncertainty: "Insufficient evidence", not "Failed". Never "approved/denied" for our own output. We report **documentation readiness**; payers and clinicians decide.

## 2. Color

The neutrals are "paper & ink": a slightly warm light canvas and a cool-ink dark canvas. The brand color is **Iris**. Verdict colors are reserved for criterion states and readiness.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F8F8F6` | `#0A0B0D` | App canvas |
| `--surface` | `#FFFFFF` | `#111316` | Cards, popovers |
| `--surface-2` / `-3` | `#F3F3F0` / `#EBEBE7` | `#16191D` / `#1D2126` | Subtle fills, tracks |
| `--border` / `-strong` | `#E4E4DF` / `#D1D1CA` | `#23272D` / `#31363E` | Hairlines |
| `--fg` / `--fg-muted` / `--fg-subtle` | `#121417` / `#565B64` / `#858A93` | `#ECEDEF` / `#A3A9B2` / `#737A84` | Text hierarchy (muted ≥ 4.5:1 on surface) |
| `--brand` (Iris) | `#3E4BDB` | `#7D87FF` | Primary actions, focus, links |
| `--met` | `#0F7A55` | `#3CC48C` | Criterion met · readiness Ready |
| `--insufficient` | `#B26B00` | `#F0A53A` | Insufficient evidence · Gaps · SLA warning |
| `--notmet` | `#C0352B` | `#F2685C` | Not met · Not supported · overdue · destructive |
| `--degraded` | `#6B7280` | `#8A919B` | Degraded mode, not evaluated |
| AI accent | `#5B5BF6 → #8B5CF6 → #1FB5CC` | same | **Only** on assistive-AI surfaces (`.ai-gradient`, `.ai-border`) |

Each semantic color has `-soft` (background) and `-fg` (text on soft) variants that meet WCAG AA. All tokens are CSS variables in `src/app/globals.css`, mapped to Tailwind via `@theme inline` (`bg-surface`, `text-muted`, `bg-met-soft`, …). Dark mode uses the `.dark` class through `next-themes`.

## 3. Typography

| Role | Face | Notes |
|---|---|---|
| UI | **Geist** (`--font-sans`) | 13 px is the workhorse size for dense tables; 14 px for reading; `ss01`/`cv11` enabled |
| Data / code | **Geist Mono** (`--font-mono`) | Case numbers, codes, hashes, SQL |
| Display | **Instrument Serif** (`--font-display`) | Marketing headlines and celebratory moments only, never in dense UI |

`.tabular` sets tabular numerals for counters, SLA timers and metrics. Headings use negative tracking (−0.02em).

## 4. Space, shape, elevation, motion

- **Spacing**: a 4/8-pt rhythm (Tailwind's default scale). Cards use 16 px padding; dense rows are 40 px tall.
- **Radius**: `xs 4 · sm 6 · md 8 · lg 12 · xl 16 · 2xl 22`. Controls use 6–8, cards 12, hero surfaces 16+.
- **Elevation**: `shadow-e1` (resting card, a 1-px ring plus a soft drop), `e2` (hover / raised), `e3` (popovers, dialogs). Borders stay hairline; depth comes from shadow, not heavy strokes.
- **Focus**: a 2-px Iris ring with offset on every interactive element (`:focus-visible`).
- **Motion**: 120–240 ms with `cubic-bezier(.25,1,.5,1)` (`--ease-out-quart`). Things *rise* in, they don't bounce. Streaming states use a gentle pulse. Everything respects `prefers-reduced-motion`; the readiness ring and hero animation skip to their final state.

## 5. Components (`src/components/ui`)

Built on Radix primitives (the unified `radix-ui` package), styled in the shadcn idiom and re-skinned to the brand:

`button` (primary · secondary · ghost · subtle · outline · danger · **ai** · link) · `input` / `textarea` / `Field` / `Label` · `controls` (Select, Checkbox, Switch, RadioCards, Tabs, Segmented) · `command` (cmdk Command + async Combobox) · `overlays` (Dialog, Sheet, Popover, HoverCard, Tooltip, Dropdown) · `display` (Badge, Avatar/Stack, Card, Skeleton, Kbd, Breadcrumb, PageHeader, DataList, Progress, Stepper, SectionLabel, CodeBlock with SQL highlighting, Dot) · `data-table` (TanStack Table: sort, filter, column visibility, selection, pagination) · `widgets` (Sparkline, StatCard, Timeline, DiffViewer, SplitPane, Dropzone) · `empty` (EmptyState with on-grid line illustrations).

Domain components (`src/components/domain`): **VerdictBadge / VerdictIcon**, **ReadinessRing** (animated), **ConfidenceMeter**, **CitationChip** (hover card with source quote), **HighlightedText** (evidence/policy marks with an active ring and scroll-into-view), **DeidText** (renders PHI tokens as redaction pills), StatusChip, PriorityChip, PayerChip, DocTypeBadge, CodeChip, live **SlaTimer**.

## 6. Patterns

- **Assistive, not autonomous.** AI shows up where the work happens: the dashboard briefing, next-best-actions on each case, live policy matches while you enter codes, gap fixes, denial-to-criteria mapping, letter drafts and the case drawer. Each AI surface has the `ai-border` treatment and shows its sources.
- **Evidence first.** Every verdict links to its policy quote and its chart span. The Evidence tab puts them side by side.
- **Show the machinery.** The retrieval inspector, model routing table, eval gates and audit chain are first-class screens, not hidden logs.
- **Absence ≠ met.** Insufficient evidence uses its own amber state, distinct from red Not met.
- **Privacy affordances.** PHI is masked by default. Revealing it needs a stated reason and creates an audit event; the UI says so before you click.
- **States.** Every async view has a skeleton, an empty state with a next step, and an error toast with an RFC 7807 message.

## 7. Accessibility

WCAG 2.1 AA contrast for text and UI in both themes; keyboard access everywhere (⌘K palette, `G`-prefixed navigation, `?` for help, `[` to toggle the sidebar); skip link; Radix-managed focus in overlays; `aria-live` for streaming and strength meters; and labels on every icon button. Layouts are responsive down to 375 px.
