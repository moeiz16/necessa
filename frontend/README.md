# Necessa — Web app

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · Radix · TanStack Query/Table · Recharts · React Flow · motion.

## Run

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

Node **20.9+** is required. `.nvmrc` pins Node 22 LTS, and Node 21 also works. The UI calls the backend at `/api/v1`, which `next.config.ts` rewrites to `NECESSA_API_ORIGIN` (default `http://localhost:8000`). Same-origin requests keep the httpOnly auth cookies and the CSRF double-submit cookie working without CORS.

```bash
npm run build && npm start   # production
npm run lint                 # ESLint (next/core-web-vitals + typescript)
npx tsc --noEmit             # type-check
```

## Demo mode (no backend, no API keys)

The whole platform runs in the browser against an in-memory mock of the API contract (`src/lib/demo/`). It includes synthetic patients, real CMS policy identifiers (e.g. LCD L36920, A56681), evaluations, letters, denials, analytics, audit, model telemetry and eval runs, and it simulates the SSE streams (case evaluation, assistant, letter drafting).

- Click **Explore the demo** on the landing page or the sign-in page, or visit `/login?demo=1`.
- To force demo mode for a static deploy (e.g. Vercel), set `NEXT_PUBLIC_DEMO_MODE=true`.
- If the backend becomes unreachable, a toast offers to switch to demo data.
- **Demo accounts** (any password) let you see RBAC in action: Maya (admin), Jordan (coordinator), Dr. Raman (clinician), Tessa (reviewer), Grace (auditor, MFA code `123456`).
- Demo state persists in `localStorage` for 12 h. Reset it from the **Demo data** pill in the top bar.

## Environment

See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `NECESSA_API_ORIGIN` | `http://localhost:8000` | Backend origin for the `/api/v1` rewrite (server-side) |
| `NEXT_PUBLIC_API_BASE` | `/api/v1` | API base path used by the browser |
| `NEXT_PUBLIC_DEMO_MODE` | `false` | `true` = always use the in-browser demo backend |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Absolute URLs for OG images |

## Structure

```
src/
  app/
    (marketing)/   landing, /security, /changelog
    (auth)/        login (+MFA), signup, forgot/reset password, invite/[token]
    onboarding/    5-step workspace setup
    (app)/         authenticated shell: dashboard, cases, cases/new, cases/[id], assistant,
                   policies, policies/[id], codes, denials, analytics, knowledge,
                   knowledge/criteria/[id], admin/{models,evals,audit}, settings, settings/organization
  components/
    brand/ ui/ domain/ shell/ cases/ assistant/ policies/ charts/ marketing/
  lib/
    api/   types (contract), client (fetch + RFC 7807 + CSRF + SSE), hooks (TanStack Query), session (+ <Can/>)
    demo/  seed data, mock router, simulated streams
```

Design decisions are documented in [`DESIGN.md`](./DESIGN.md).
