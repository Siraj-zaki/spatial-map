# Frontend patterns

Read this before writing or changing any React/TypeScript code in `src/` — it covers state, data access, styling, theming, i18n, and the map overlay conventions. For the frontend gotcha table (the "this bit us once" list), see `docs/pitfalls-frontend.md`.

## State management: `useSpatialStore`, never bypass

All catalog entities (zones, grids, bins, polygons, circles, lines, markers, images, models, stairs, doors, textLabels, styleRules, attributeDefinitions, connections, streams) flow through `useSpatialStore` (`src/lib/spatial-store.ts`).

**Do this:**
```ts
// Read
const polygons = useSpatialStore(s => s.polygons)

// Optimistic write — UI updates immediately (applied once per frame),
// saved when the edit settles (400 ms) — one request per entity
useSpatialStore.getState().updateLocal('polygons', id, { config: { color: '#ff0000' } })

// Save now (toggle, rename, slider release) — resolves when confirmed
await saveSpatialEntity('polygons', id, { visible: false })
await useSpatialStore.getState().commit('polygons', id)   // or commit() for everything

// Repeated relative edits (arrow-key nudges): patch from the LATEST value
updateSpatialLatest<PolygonShape>('polygons', id, (p) => ({ rotation: (p.rotation ?? 0) + 15 }))

// Create new entity (negative temp id locally → server id after flush)
useSpatialStore.getState().createLocal('polygons', { name, vertices, config, ... })
```

**Don't do this:**
- ❌ Call `apiDb.polygons.update(id, ...)` directly from a component — it bypasses optimistic state.
- ❌ Manually maintain local component state for entity edits — the store's drafts already handle in-flight reconciliation.
- ❌ Clear drafts manually after a save — the store does it during flush.
- ❌ Keep a route-level draft (`useState`) of an entity and clear it after firing the save — the map snaps back to the old value until the response lands. The store's draft already holds until the server confirms.
- ❌ Build a patch from a render-time copy for repeated edits (`{ ...selected.config, x: selected.config.x + 1 }`) — use `updateSpatialLatest` / `getSpatialEntity`.
- ❌ Pass inline lambdas or shape-list-dependent callbacks to memoised editor chrome (`MapToolbar`) — use `useCallback` / `useStableCallback`; mount heavy dialogs only while open.

## Data access: `apiDb` for direct CRUD, `apiGet/Post/...` for ad-hoc

- For typed entity CRUD: `apiDb.<table>.toArray() | get(id) | add() | update(id, patch) | delete(id)` (`src/lib/api-db.ts`).
- For non-table endpoints (settings, public warehouse, uploads, probes): `apiGet | apiPost | apiPut | apiPatch | apiDelete` from `src/lib/api-client.ts`.
- For external (unauthed) reads: `publicFetch<T>()`.
- All `apiDb`/`apiFetch` calls auto-inject `X-Api-Key` and `X-Tenant-Id`. Don't add them yourself.
- Response envelope `{ data: T }` is unwrapped automatically. Pass `rawResponse: true` if you need the raw response.

## Real-time updates: `useSSE`, don't poll

- `useSSE(tenantId, enabled)` is mounted by the map editor (`useEditorBootstrap`) and the viewer (`view.tsx`) — **not** at the app root, so `subscribeExternalSSE` listeners on other pages (`/data`, `/integrations`, `/files`, `/subscription`) only fire while one of those is mounted. Don't add per-component streams.
- The stream is read with `fetch` (not `EventSource`) so it can send `Authorization` + `X-Tenant-Id`; the server only sends that tenant's events and rotates the connection every ~50s (the hook reconnects immediately on a clean end, backs off on errors, waits 30s after 401/403).
- If you add a new entity kind, register it in the store's reload table so SSE invalidations route correctly.
- For pages still on polling (dashboards), use `useApiQuery(fetcher, deps, options)` with a unique prefix as `deps[0]` so cache invalidation works.

## Authentication: `auth-store` + `auth-client`

- Session state lives in `useAuthStore` (`src/lib/auth-store.ts`). Persisted to localStorage under key `sgv-auth`.
- **Read the current user**: `const user = useAuthStore(s => s.user)`. Returns `null` when not logged in.
- **Get token for outgoing requests**: don't — `api-client.ts` already stamps `Authorization: Bearer` from `getAuthToken()`. Don't read the token in components.
- **Sign in / sign out**: use `login/signup/logout` from `src/lib/auth-client.ts`. Login + logout also call `resetTenantStore()` so don't manually clear the tenant.
- **Protected routes**: wrap with `<AuthGuard>` in App.tsx. New protected screens go inside the same `<Route path="*" element={<AuthGuard><AppContent /></AuthGuard>} />` block.
- **Public routes**: declare them BEFORE the catch-all guard in App.tsx (see how `/view`, `/share`, `/login`, `/signup` are structured).
- **Role checks in UI**: `roleForTenant(tenantId)` returns `'owner' | 'admin' | 'editor' | 'viewer' | null`. Gate destructive UI (delete, member-invite) by role.
- **Member management UI**: at `/members` (`src/routes/members.tsx`). Read-only for editor/viewer roles; owners/admins see invite + role-change + remove controls. Uses `listMembers/inviteMember/updateMemberRole/removeMember` from `auth-client.ts`.
- **Profile UI**: at `/profile` (`src/routes/profile.tsx`). Editable fields: `displayName, bio, location, pronouns, jobTitle, avatarUrl`. Uses `getProfile/updateProfile/uploadAvatar` from `src/lib/profile-client.ts`. Updates flow through `useAuthStore.setUser()` so the header avatar refreshes instantly.
- **Avatar storage** lives in the same object store as warehouse images/models (`internal/store`). Uploaded files served at `/files/{key}`. 5 MB cap, must be `image/*`.
- **Guest-only routes**: `/login` and `/signup` are wrapped in `<GuestOnly>` (same file as `AuthGuard`) so a signed-in visitor goes on to `state.from` / `/dashboard`. `/forgot-password` is intentionally not wrapped — it doubles as "change password" until a profile screen exists.
- **Auth screens are built from `src/components/auth/`** (`AuthLayout`, `AuthHeader`, `AuthInput`, `PasswordInput`, `OtpInput`, `AuthOtpStep`, `StepProgress`/`StepTransition`, `AuthAlert`, `AuthSubmitButton`). A new public auth screen (e.g. accept-invite) should compose these rather than restyle a card — see ARCHITECTURE.md §3 "Auth screens".
- **Never render an auth API error's `message`.** Pass the caught error to `describeAuthError` (`src/lib/auth-errors.ts`) and render `t(info.key)`; the server's `error` text is English and meant for logs. `info.field` says which input to mark + focus, `info.retryAfter` feeds `useCountdown` for the 429 lockout. A new backend auth error code needs a `case` there and an `auth.errors.*` key in all six locales.
- **Auth form rules** (from the 2026-09 research pass — NN/g, Baymard, web.dev, OWASP, WCAG 2.2): `noValidate` + our own translated validation on submit, errors cleared as soon as the field is edited, never clear what the user typed on a server error, don't disable submit while the user is still typing (`AuthSubmitButton` only goes inert while loading or rate-limited), correct `autocomplete` tokens (`username` / `current-password` / `new-password` / `one-time-code`), a hidden `username` input on password-only steps, paste always allowed. Motion uses the `.sgv-auth-*` classes, which are static unless `prefers-reduced-motion: no-preference`.
- **Marketing visuals come from the real product, not illustrations.** The auth brand panel plays footage captured from the app (frame-by-frame viewer captures of the demo workspace, light + dark takes), edited into a loop that shows the breadth of the product — whole-facility orbits of more than one facility type plus live people/equipment — not a single camera move of one building. Don't substitute a synthetic SVG/illustration for product imagery when captures exist. Video: mount only where it's visible (`useMediaQuery`), poster still under reduced motion and on mobile, one take per mode.

## Bulk-editing multi-selected shapes

When N shapes of the same kind are selected, the side panel switches to `<kind>-bulk` mode. To add a new bulk-editable field:

1. In `src/components/side-panel.tsx`, find `Bulk<Kind>ShapeContent` and add another row inside one of its `<Section>`s. Pick from `BulkColorRow`, `BulkSliderRow`, `BulkNumberRow`, `BulkToggleRow`.
2. Use `sharedValue(shapes, s => s.config.<field>)` (from `@/lib/bulk-edit`) to derive `{ value, isMixed }`. Pass `isMixed` to the row so it shows the "Mixed" badge.
3. Each row's `onChange` fires `onPatchAll?.({ <field>: newValue })` — partial config patch only.
4. No backend changes — `handleBulkPatch<Kind>` in `create-grids/handlers/useBulkHandlers.ts` already merges any field of the kind's config across selected ids via `patchSpatialEntity`. Doors are the one exception (they go through `useDoorStore.updateDoorConfig`).

**Don't** build a parallel "edit-all-fields" form mirroring the single-selection editor. Bulk panels are deliberately partial-patch — listing only fields users actually want to bulk-change keeps the UI focused and avoids clobbering individual values.

**Don't** add a bulk field that isn't a property of the shape's `config` object (e.g. rotation, position, vertices) — those need per-shape patches, not bulk-config merges.

## Page building blocks (2026-09 redesign)

Build every workspace page from the shared kit — don't hand-roll another hero, KPI tile, table style or empty state:
- `PageContainer` + `PageHero` (title, one-line description, actions) + `PageChapter` from `page-shell.tsx`.
- `StatCard` for KPIs; `Card`/`Badge`/`Table`/`Tabs`/`Tooltip`/`Skeleton` from `components/ui/`; `EmptyState` with the action that fixes the emptiness.
- `FilterTabs` for any "All · A · B" filter with counts; `BrowseLayout` for sidebar + content pages (files, data). Row actions go in a single always-visible "⋯" `DropdownMenu`, not hover-only icon rows.
- A problem that affects many items gets ONE page-level notice with a "show only these" filter, plus a small `Badge` per item — never the same banner repeated on every card.
- Every page designs all its states, not just the happy path: skeleton loading (reserve final layout), `QueryError` on failure (never raw server text, never KPIs showing false zeros), empty/first-use `EmptyState` with the fixing action, no-results with "Clear filters", and a role-limited view.
- Feedback: `toast.*` for completed actions, `ConfirmDialog` for destructive ones (type-to-confirm when it deletes a lot), never `window.confirm()`. Filters/sort/view/tab go through `useUrlState` so refresh and shared links keep them.
- One-click-reversible deletes (a table row) delete immediately with an **Undo** toast instead of a confirm; keep `ConfirmDialog` for what can't be undone.
- Role-limited controls: render them `disabled` inside `RoleGate` (`components/feedback/role-gate.tsx`) so the tooltip says why — don't hide them.
- Timestamps in tables: `relativeTime()` in the cell, `fullTime()` in `title` (`lib/relative-time.ts`).
- Wide content (curl, code, grids) inside a shadcn `DialogContent` needs a `min-w-0` wrapper — the content is a CSS grid and the widest child otherwise sets the dialog's width.
- Editing flows with several fields (report builder, profile): Save is always reachable (header or a sticky save bar that appears only when dirty), ⌘/Ctrl+S saves, `beforeunload` warns while dirty, leaving via our own Back/Cancel asks before discarding, success is a toast. Compare against a snapshot of what a save would send — not against field-by-field state.
- Settings pages use labelled sections (title + one-line explanation on the left, controls on the right) — see `routes/profile.tsx`.
- Derive "loading" from a query key (`result?.key !== queryKey`) instead of `setLoading(true)` at the top of an effect — the React 19 lint flags the latter.
- Colour carries meaning only: monochrome icons, `success/warning/danger/info` tokens for state. No per-tile rainbow tones. Categorical data (chart series, report KPI tones, value chips) uses `--chart-1…8` (`hsl(var(--chart-n))`, or the Tailwind `chart-n` colours: `text-chart-3`, `bg-chart-1/10`) — never `--primary`, which is near-black in the default palette, and never raw Tailwind hues (`text-emerald-600`). `--chart-8` is the neutral "Other". A single-series report chart uses the report's own colour (`ReportAccentContext`).
- Copy is for users: say what the thing is and what to do next — never implementation notes ("filter-aware", "schema-first").
- New nav destinations go in `components/app-shell/nav-items.ts` (+ `nav.*` in all six locales).

## Loading states (2026-10)

Every wait has exactly one indicator — pick by scope, never a bare blank or an empty state while data is in flight:

| Wait | Use |
|---|---|
| App start (translations) | `BootSplash` — main.tsx's Suspense fallback; no i18n, reads the saved theme itself |
| Session check / first workspace lookup / local-data sync | `AppSplash` (`components/feedback/app-splash.tsx`) — AuthGuard, TenantProvider (signed-in only, until the workspace id is known — pages gate fetches on it, so rendering earlier flashed "No facilities yet") |
| A screen loading after navigation, any save / delete / upload | automatic — the top bar (`src/lib/loading-bar.ts`); background polling / live refreshes pass `{ silent: true }` |
| A page's list / cards / charts | skeletons in the page (`Skeleton`, kind-shaped `WidgetSkeleton`) |
| A map | automatic — `MapboxMap` shows a placeholder until its first style loads and a "Loading map…" pill while a basemap swaps; pass `busy` + `busyLabel` while the facility's floors / shapes load (viewer, editor) |
| A button that awaits | local `busy` state: disable, swap the icon for `Loader2 animate-spin motion-reduce:animate-none`, `aria-busy`, toast on failure; a menu item that fetches before its dialog opens → spin its trigger + `beginLoading()` |
| Something can't load | an error state with Retry (`QueryError`, or a page-specific card like the viewer's `ViewerLoadError`) — never an endless spinner |

Indeterminate motion uses `.sgv-indeterminate` (index.css) — the one deliberate loop, static under reduced motion.

## Styling: shadcn tokens + Tailwind + `sgv-` prefix for outliers

**Theme tokens** are HSL CSS variables defined in `src/index.css`. Light + dark via `.dark` class on `<html>`. Tailwind extends colors to point at these (`bg-background`, `text-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`, `bg-destructive`, `bg-muted`, `bg-accent`, `bg-popover`, `bg-card`).

**Do this:**
```tsx
<div className="bg-card text-card-foreground border border-border rounded-md p-4">
  <p className="text-muted-foreground">Subtitle</p>
  <Button variant="destructive">Delete</Button>
</div>
```

**Don't do this:**
- ❌ Hard-coded hex colors (`bg-[#fafafa]`, `text-gray-900`) — they'll break dark mode.
- ❌ Tailwind palette colors directly (`bg-zinc-100`) outside of intentional one-offs — use theme tokens.
- ❌ Inline `style={{ color: '#...' }}` for layout — only acceptable for dynamic per-feature colors (e.g., user-picked polygon color).

**For app-specific styles** that don't fit Tailwind (Mapbox popups, complex tooltips, semantic accent palettes), use the **`sgv-` / `sgv-tt-` prefix** for CSS class names (see existing `.sgv-tt` block in `src/index.css`). The tooltip system uses semantic variants: `success`, `warning`, `danger`, `critical`, `info`, `primary`, `cool`, `hot`, `neutral` — match these when adding new badge/chip kinds.

**Shared utilities in `src/index.css`**:
- `.sgv-scroll-hide` — visually hide the scrollbar on a scrollable surface while keeping it scrollable. Use on tight overflow containers (map-toolbar rail, viewer controls stack) where a visible scrollbar would eat into content width.

**Viewport units**: prefer `dvh` / `dvw` over `vh` / `vw` for full-viewport sizing. The dynamic variants account for mobile URL-bar collapse so the layout doesn't clip. PageContainer, dialogs, route shells, and the viewer all use `dvh`-based heights.

**Sticky table headers**: the pattern is `<div className="... overflow-auto max-h-[NNdvh]"><table><thead className="sticky top-0 z-10 bg-card ...">` — the outer div establishes the scroll container (both axes because of the CSS overflow quirk that promotes `overflow-x: auto` to `overflow-y: auto`), and the thead sticks to its top. Use a solid background on the thead (`bg-card`, `bg-muted`) so rows scrolling under don't bleed through.

**shadcn components**: when adding a new shadcn primitive, use `npx shadcn@latest add <name>` so it lands at `src/components/ui/` with the project's style (`new-york`, base color `zinc`, CSS vars enabled).

**Sheet vs Drawer vs Dialog**: pick the right primitive for the surface.
- `Sheet` (`src/components/ui/sheet.tsx`) — side-anchored panel built on Radix `DialogPrimitive`. Use for mobile sidebar drawers and any side panel that should slide in from a screen edge. `side` prop: `"start" | "end" | "top" | "bottom"` (default `"end"`). `hideDefaultClose` suppresses the built-in X when the host provides its own close button. Width is `w-[min(320px,85vw)]` for start/end; max-h `85dvh` for top/bottom. Uses logical properties (`start-0` / `end-0`) so it lands correctly in RTL. **For mobile sidebar drawers** (data, files routes), render the same sidebar content via an inline `renderSidebar` arrow function shared between the desktop `<aside>` (hidden below `md`) and the `<Sheet>` (shown below `md`) — this avoids prop-drilling a sidebar component around.
- `Drawer` (`src/components/ui/drawer.tsx`, vaul-based) — bottom-anchored only. Use for mobile bottom sheets like the view detail panel; do **not** use for side panels.
- `Dialog` (`src/components/ui/dialog.tsx`) — centered modal. Use for confirmations and forms that aren't navigation.

**Dialog sizing + header patterns.** The default `DialogContent` is `w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto` — `w-full` clamps it to the viewport on mobile, the max-w keeps it centered on desktop, and the dvh-based max-h makes the whole dialog scroll when the body is taller than the viewport. Three patterns cover every dialog in the app:
- **Simple confirmation** (delete, leave-page, single-field forms): `<DialogContent className="sm:max-w-md p-6"><DialogHeader><DialogTitle>…</DialogTitle><DialogDescription>…</DialogDescription></DialogHeader>…</DialogContent>`. The default `DialogHeader` is `flex flex-col space-y-1.5 text-center sm:text-start` — fine for short copy. Use `sm:max-w-md` (448px) for confirmations, `sm:max-w-lg` (default, 512px) for short forms.
- **Complex with sticky header** (multi-section editors, list pickers, the share-link tabs): `<DialogContent className="max-w-3xl w-[95vw] p-0 gap-0 overflow-hidden flex flex-col"><DialogHeader className="flex flex-row items-center gap-3 px-5 py-4 border-b space-y-0 flex-shrink-0"><div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center"><Icon className="w-4 h-4 text-primary" /></div><div className="flex-1 min-w-0"><DialogTitle className="font-semibold text-base leading-tight">…</DialogTitle><DialogDescription className="text-xs text-muted-foreground leading-snug mt-0.5">…</DialogDescription></div></DialogHeader><div className="flex-1 min-h-0 overflow-y-auto">…body…</div></DialogContent>`. The `p-0 gap-0 overflow-hidden flex flex-col` on the content + `flex-shrink-0` on the header + `flex-1 min-h-0 overflow-y-auto` on the body is the recipe that lets the body scroll under a pinned header.
- **Full-screen workspace** (data-link-editor-v3, table-records): `<DialogContent className="w-[90vw] max-w-none sm:max-w-none max-h-[92dvh] flex flex-col p-0 gap-0">`. Reserve this for surfaces that act like a page inside a dialog (multi-pane layouts with their own internal scroll). Don't reach for it just because a form has many fields — extend the complex pattern instead.

Width convention: `sm:max-w-md` (448px) for confirmations, `sm:max-w-lg` (512px) for short forms, `max-w-2xl` (672px) for medium, `max-w-3xl` (768px) for large, `max-w-4xl` (896px) for tabbed/multi-pane, `max-w-5xl` (1024px) for data tables. Bare `max-w-*` (without `sm:`) is fine — `w-full` already clamps to the viewport on mobile, so the `sm:` prefix is cosmetic. The `w-[95vw]` on large dialogs is intentional: it makes the dialog nearly-full-width on tablet (768–1024px) without the `max-w-3xl` cap kicking in.

**Dialog action footer pattern.** When a dialog has primary actions (Save, Apply, Create, Use this drawing), use a sticky footer at the bottom of the `DialogContent` flex column:

- `<div className="border-t bg-background flex-shrink-0 px-6 py-4 flex items-center justify-end gap-2">` — single-action footer (one button on the right).
- `<div className="border-t bg-background flex-shrink-0 px-6 py-4 flex items-center justify-between gap-3">` — two-action footer with optional hint: status hint on the left, Cancel + primary action on the right (`<div className="flex items-center gap-2 flex-shrink-0">`).

The `px-*` should match the dialog header's `px-*` so the footer buttons align with the title above. `bg-background` (not `bg-muted/20` or `bg-muted/30`) — `border-t` is the visual separator, the footer doesn't need its own tint, and `bg-background` keeps the buttons reading as the same surface as the body. `flex-shrink-0` so the footer doesn't get squeezed when the body grows. Reference implementations: `bulk-assign-dialog.tsx` (two-action with hint), `data-link-editor-v3.tsx` (delete-left + enabled/save-right), `share-link-dialog.tsx` (conditional footer per tab).

## Theming (mode × palette)

- **Two orthogonal axes**, both managed by `ThemeProvider` (`src/components/theme-provider.tsx`):
  - `mode: 'light' | 'dark' | 'system'` — applies `.light` / `.dark` to `<html>`. Controlled by `<ModeToggle />`.
  - `palette` — applies `.theme-<id>` to `<html>` (no class for `default` Zinc). Controlled by `<ThemePicker />`. **46 palettes available**: `default` (Zinc) + 45 colored options organized in spectrum order: reds (red, crimson, maroon, scarlet) → oranges (orange, tangerine, coral, salmon, peach) → yellows/golds (amber, gold, mustard, yellow) → greens (lime, olive, sage, green, forest, emerald, mint, jade, teal) → blues (cyan, ocean, sky, blue, navy, royal, indigo, periwinkle) → purples/pinks (violet, lavender, purple, plum, fuchsia, magenta, mauve, pink, rose) → earth/neutrals (slate, stone, bronze, copper, mocha, midnight). Light primary ≈ Tailwind 500–600, dark primary ≈ Tailwind 400–500. Light-warm-tone palettes (yellow, amber, gold, mustard, peach, salmon) use dark foregrounds because white-on-light-warm fails WCAG contrast.
- The two combine: `<html class="dark theme-blue">` = dark blue, `<html class="theme-rose">` = light rose.
- Mode persists to `vite-ui-theme`, palette to `vite-ui-theme:palette` in localStorage.
- **Always test across both axes.** Bare minimum: light/dark in default + one tinted palette. The palette overrides ONLY `--primary` / `--primary-foreground` / `--ring`; surface tokens stay neutral.
- Map styles also pair with mode — `main-light`/`main-dark` in `map-styles.json`. Don't assume one.
- 3D model `model-color-mix-intensity` + `model-emissive-strength` may need separate tuning per mode.
- **Public/chrome-less screens** (login, signup, future preview/error pages) should include `<LanguageSwitcher />` + `<ThemePicker />` + `<ModeToggle />` in the top-end corner — not every user lands logged in, and they need to adjust language/palette/mode before signing in. See `src/routes/login.tsx` for the pattern (`absolute top-3 end-3 flex items-center gap-1`).
- **Adding a new palette:** add the CSS block under `@layer base` in `src/index.css` (light + dark variants), append to `PALETTES` array in `theme-provider.tsx` with a swatch hex, add the i18n labels in all 6 locales. No other touch points.

## i18n: never hardcode user-facing strings

```tsx
import { useTranslation } from 'react-i18next'

function Foo() {
  const { t } = useTranslation()
  return <button>{t('common.save')}</button>
}
```

- Add new keys to **all six** `public/locales/<lang>/translation.json` files (en, es, fr, de, ar, zh). At minimum add the English string and leave others as the English fallback if you can't translate — never delete keys to "fix later."
- Arabic is RTL. For new UI, verify with `dir="rtl"` rendering.
- For unit-bearing values, use `formatLength(meters, unit)` from `src/lib/units.ts` — don't manually concatenate `${value} ${unit}`.

**Technical notation needs `dir="ltr"`.** A dimension readout (`91.4 × 61.0 m`), a ratio (`1:100`), a scale (`1/8" = 1'-0"`) or a sheet size (`ARCH D · 914 × 610 mm`) is a **formula, not prose**. Dropped raw into an RTL paragraph, the bidi algorithm floats the trailing Latin unit to the front (`m 61.0 × 91.4`) or shreds the notation entirely (`"0-'1 = "1/2`). Put `dir="ltr"` on the element that wraps the value. Translated strings that embed their own localized unit (`{{width}} × {{height}} م · بالمقياس`) are fine as-is — bidi orders those correctly.

**Arabic plurals need six forms, not two.** i18next resolves via `Intl.PluralRules`, and Arabic returns `zero / one / two / few / many / other` — count=3 lands on **`few`**. Supplying only `key_one` / `key_other` means every count in 3–10 silently falls back to the English string. When you add a counted key, give Arabic all six (`_zero`, `_one`, `_two`, `_few`, `_many`, `_other`); en/es/fr/de need `_one` + `_other`, zh needs only `_other`. Also **don't pass a bare `defaultValue`** to a `t()` call that uses `count` — i18next wants suffixed defaults (`defaultValue_one` / `defaultValue_other`), and a single unsuffixed one was observed winning over the real plural keys.

**i18n namespaces by component.** When adding strings to a component, use the matching top-level namespace — don't scatter keys across `common.*` or ad-hoc sections. The namespaces added/refactored in the Phase 7 i18n sweep:

| Namespace | Component | Notes |
|---|---|---|
| `alerts.*` | `alerts-panel.tsx` | Alert count (`_one`/`_other`, Arabic gets `_zero`), expand/collapse, ack-all, timeAgo |
| `binPopup.*` | `bin-popup-content.tsx` | `FieldRow.t` is optional (exported, used by `routes/view.tsx`); `JsonRow` falls back to `'JSON'` when `t` is absent |
| `styleRuleEditor.*` | `style-rules/style-rule-editor.tsx` | Math symbols (`=`, `≠`, `<`, `≤`, `>`, `≥`) stay hardcoded in `opLabel()`; word labels go through `t('styleRuleEditor.op.*')`. `TFunc` type passed to child components (`TargetPicker`, `SourcePicker`, `CellCoords`, `AttrConditionRow`, `AggregateConditionRow`, `ValueInput`, `ColorField`) |
| `filterTree.*` | `data-link/filter-tree-builder.tsx` | `OP_LABEL`/`OP_HINT` remain exported consts (used by `viewer-filter-bar.tsx`) — the component uses `t('filterTree.op.*')` / `t('filterTree.opHint.*')` instead. `SchemaStatus` calls `useTranslation()` internally. |

**Passing `t` to child components.** When a component splits into sub-components that all need translations, define `type TFunc = (key: string, opts?: Record<string, unknown>) => string` at the top of the file and pass `t` as a prop. This avoids each sub-component calling `useTranslation()` independently (which is fine but adds hook overhead per row in long lists like conditions). For exported components used externally, make `t` optional with a hardcoded English fallback so callers without `t` don't break.

## Click priority across overlays

Mapbox dispatches per-layer click handlers in registration order, NOT layer-stack order. Area-fill overlays (polygon, circle) register before narrower shapes (line, model) because they mount earlier in the editor's render tree — so they'd claim clicks meant for shapes drawn on top of them.

**Always call `higherPriorityAt(map, e.point, '<kind>')`** from `@/lib/overlay-hit-priority` at the top of any new overlay's click handler. If it returns true, return early without `preventDefault` — the more-specific overlay's handler will claim the click when it runs.

Priority: `text > model > stair > door > line > polygon > circle > grid > image`. Markers handle clicks via DOM and aren't in the priority list — an occluded marker gets `pointer-events: none` so a marker you can't see can't swallow a click meant for the floor above it.

When adding a new shape kind, also extend `kindOfLayer()` in `overlay-hit-priority.ts` to recognize your overlay's layer ids — preview/draft/selection-outline layers must return `null` so they don't block the real shape's selection.

## Mapbox-specific patterns

- **Opacity bucketing**: Mapbox 3.x rejects data expressions on `fill-extrusion-opacity`. If you need per-feature opacity, generators stamp `opacityBucket: 0|10|20|...|100` on features and you route them to per-bucket layers. Follow `map-polygon-overlay.tsx` as the template.
- **One source per kind, one (or N) layers per kind.** Don't mix kinds in a source.
- **GLB models**: must be self-contained `.glb`. Multi-file `.gltf + .bin + textures/` packs need `npm run models:build` to re-pack via `gltf-pipeline`. Mapbox is strict about bin chunk offsets.
- **Custom draw modes**: live in `src/lib/grid-draw-mode.ts`. Two-click pattern (anchor → commit), no live preview. If you add a new tool, mirror that shape — don't subclass `direct_select` with weird overrides.
- **Hit-testing for non-fill layers** (images, lines, points): add a parallel GeoJSON hit-test layer that's transparent. Mapbox's `queryRenderedFeatures` can't hit raster sources directly.
- **Tooltip popups** are rendered outside the React tree by `mapboxgl.Popup`. Style globally with `sgv-tt-*` classes; mount React content via `ReactDOM.createRoot` into the popup's element if you need React inside (see existing patterns in `map-bin-overlay.tsx`).
- **Marker depth occlusion**: HTML markers live above the canvas and are invisible to the GL depth buffer, so geometry stacked above them can't hide them the way it hides a GL layer. `src/lib/marker-occlusion.ts` recovers the depth test analytically — every extruded shape becomes a **prism** (footprint ring + `elevation → elevation + height` band), and the camera→marker ray is clipped to each prism's altitude slab and tested against the footprint. One test covers "standing under a slab" and "standing behind a wall". `map-marker-overlay.tsx` stamps `data-occluded="true"` and a rule in `index.css` hides the element. If you build another DOM-based overlay that needs to sit inside the 3D stack, reuse `computeOccludedMarkerIds` rather than inventing a second scheme.
  - **Adding a kind to the occluder set** means adding a loop in `buildOccluders` that pulls the footprint from that kind's **own generator** and its `elevation`/`height` from config, then threading the array into the `occluders` bag at both hosts (`create-grids/layers/SecondaryLayers.tsx` and `routes/view.tsx`). Never re-derive a footprint from raw `vertices` — rotation, wall thickness and image crops live in the generator.
  - Pass each array gated on **its own** layer-visibility flag. The arrays are already warehouse-scoped, so the hidden-floor cascade comes along for free; geometry that paints nothing must occlude nothing.
  - Kinds deliberately excluded: 3D models, image planes, grids/bins. A GLB only offers a bounding box, and a mall-sized box would hide markers that should be visible. If you need those, go to a GPU depth probe rather than widening the analytic path.
  - Occlusion is a *view* concern only: it never writes to the store, and the marker rows are untouched. Don't "fix" a hidden marker by patching its `visible` flag.
- **Empty layers are hidden for you.** `src/lib/empty-layer-gate.ts` is installed on the map in `mapbox-map.tsx` before any overlay mounts. It wraps `addSource`/`addLayer`/`removeSource`/`removeLayer`/`setLayoutProperty` plus each GeoJSON source's `setData`, and sets `visibility: 'none'` on any layer whose source holds zero features — the only mutation GL JS treats as free per frame. Overlays need no changes: keep calling `source.setData(fc)` and the gate follows. Two things you must not break: an app-authored `setLayoutProperty(id, 'visibility', 'none')` always wins over incoming data (that's what keeps the per-kind toggles honest), and a source whose feature count can't be read is left visible. If you need a layer conditionally hidden, express it as a normal `setLayoutProperty` call rather than emptying the source or adding a false filter.

## Generators (shape geometry → GeoJSON)

If you add a new shape kind:

1. Define types in `src/lib/shapes.ts` (or its own file if large).
2. Add a generator at `src/lib/<kind>-generators.ts` that exports a `build<Kind>Feature(shape, ...): Feature<...>` function.
3. The feature `properties` should stamp every visual override the layer paint expression reads (color, opacity, opacityBucket, elevation, label, etc.). Compute once, don't read live state from paint expressions.
4. Add a `map-<kind>-overlay.tsx` that subscribes to the store, runs the generator, and renders sources/layers.
5. **Live draw preview is required.** Every creation tool must render a preview of the would-be shape while the user is drawing — not just a guide chain. The convention: build a fake "livePreview" shape from the in-progress draft state and pass it to `build<Kind>FeatureCollection(..., livePreview, ...)`. The committed-shape paint reuses for the preview so it always shows what you'll actually get. See `map-circle-overlay.tsx` and `map-polygon-overlay.tsx` for the pattern.
6. Register the kind in `useSpatialStore` (state slice + load/create/update/delete actions).
7. Add backend handlers, query, migration (see `docs/backend.md`).

## AI Map tool (Python ai-worker detection)

The `create-ai-map` tool (letter `A`, Sparkles icon) is the one place where a
UI action triggers a heavy backend pipeline. It's its own subsystem — see
`docs/ai-floorplan.md` for architecture, pipeline stages, and the
kind-vocabulary boundary. Frontend touch points:

- **`src/lib/ai-client.ts`** — the 4 REST endpoints (start / get / cancel /
  feedback). `startDetection` accepts an optional `region` for region-select
  mode.
- **`src/lib/ai-detection-generator.ts`** + **`src/components/map-ai-detection-overlay.tsx`**
  — GeoJSON + Mapbox layers for draft detections. Overlay is mounted OUTSIDE
  the layer-order fragment (next to `SecondaryLayers`, not inside
  `OverlayStack`) so a warehouse re-order doesn't tear it down mid-review.
- **`src/lib/ai-accept.ts`** — turns an accepted detection into a real shape
  row via `apiDb.<kind>.add`. Kind→apiDb: aisle→lines, area→polygons,
  door→doors, stair→stairs (matches `layerLine: "Aisles / lines"` — aisles
  ARE lines in this project). The SPA kind vocabulary is the source of
  truth: the Python worker remaps its generic CV terms (`wall`/`room`) to
  `aisle`/`area` at emit time (`run.py::_KIND_TO_SPA`).
- **`src/lib/image-generators.ts::imageUVToLngLat` + `imageLngLatToUV`** —
  bidirectional coord helpers, JS mirrors of the Python worker's
  `pipeline/reproject.py::pixel_to_lnglat`. The Python side does the
  forward reprojection so detections arrive already in Mapbox lng/lat;
  the inverse is used by the region-select drag to convert map lng/lat
  into the UV region the worker crops by.
- **`src/routes/create-grids/hooks/useAIMapTool.ts`** — job lifecycle,
  SSE subscription on `entity="ai-jobs"` (routes via
  `subscribeExternalSSE`, NOT `VALID_KINDS`), accept/reject state.
  `startForImage(id, region?)` accepts the optional drag region.
- **`src/components/ai-detection-review-dialog.tsx`** — per-detection Accept
  / Reject + bulk "Accept N above X%" + cancel-in-flight-job button.
- **Region-select drag** lives in `create-grids/index.tsx`. A mousedown
  ref captures the drag start while `activeTool === 'ai-map'`; the
  image-click handler compares screen distance (>10px = drag = region,
  else = click = whole image), computes UV corners via
  `imageLngLatToUV`, clamps to `[0,1]`, and calls
  `aiMap.startForImage(id, region)`.

Convention: Accept batches use direct `Promise.all` over `apiDb.X.add` (not
`createLocal`) — same as magic-wall. `queryCache.invalidate` fires once per
kind touched, not once per detection.

## Forms & validation

- Zod (`zod` v4) for client-side schemas where reused (e.g., import plans).
- For simple field-level validation, controlled inputs + inline conditionals are fine.
- No React Hook Form / Formik in this codebase — don't introduce new form libs.

## Slider ranges vs limits

A side-panel slider's `max` is the comfortable drag range, not necessarily the real limit. Use `SliderRow` and decide per field:

- **True limits** (opacity, 0–1 material values, angles, zoom, crop %): leave `limitMax` off — the typed value is capped at `max` too.
- **Sizes, distances, counts** (door width, elevation, stair steps, rack levels, text/marker/stroke px): pass `limitMax` from `src/lib/input-limits.ts`. Typing past the slider then works, and `StretchSlider` widens the range so the thumb never pins and the next drag never snaps the value back to `max`.
- A field laid out as label + `NumberInput` + bare slider uses `StretchSlider` directly with the same `limitMax`, and gives the `NumberInput` the same `max`.
- Clamps elsewhere must match: `setPendingWidthMeters` in `src/lib/door/store.ts` used to cap door width at 6 m regardless of the field, and `onChange` handlers like stair steps / rack levels clamp to the same constant. Grep for `Math.min(<old max>` when you raise one.

## Form control focus rings

- shadcn `Input` (`src/components/ui/input.tsx`) ships with
  `focus-visible:ring-1 focus-visible:ring-ring` — that's the baseline
  every text input inherits.
- `Button` has the same `focus-visible:ring-1` baseline.
- Native `<select>` elements get a `@layer base` rule in `src/index.css`
  (`select:focus-visible { @apply outline-none ring-1 ring-ring; }`)
  that provides the same ring-1 indicator without needing per-site
  `focus-visible:*` utilities. Most selects in the app are bare
  `<select>` elements; without this rule they'd have no focus
  indicator at all. When a select needs a stronger ring (e.g. ring-2
  with offset), Tailwind's `focus-visible:ring-*` utilities win on
  specificity and override cleanly.
- Sidebar navigation buttons (the `SidebarItem` components in
  `routes/data.tsx` and `routes/files.tsx`) use `focus-visible:ring-1
  focus-visible:ring-inset` so the ring renders inside the row —
  tight against the sidebar edge — plus `aria-current="page"` on the
  active item so screen readers announce the current location.

## Scroll & viewport hygiene

- **Viewport units**: use `dvh` / `dvw` (dynamic) instead of `vh` / `vw`
  everywhere a height/width tracks the visible viewport. `vh` doesn't
  account for mobile URL-bar expansion, so a `100vh` container leaks
  under the address bar and clips the bottom row. `PageContainer`
  (`src/components/page-shell.tsx`) is `h-[calc(100dvh-3rem)]` for
  this reason; `Dialog`/`Drawer`/`Sheet` all use `dvh` for the same.
- **Scroll-to-top on route change**: `src/components/scroll-to-top.tsx`
  mounts inside `BrowserRouter` and resets `window.scrollTo(0, 0)` on
  `pathname` change. Routes that own their scroll container
  (`PageContainer`, `/data`, `/files`) remount on route change so their
  inner scroll resets naturally; only the document (used by
  `/profile`, `/members`, `/tables`, etc.) needs this. The listener
  keys on `pathname` only — `search` changes preserve scroll so
  filter/tab changes within a page don't jump.
- **`overscroll-contain`** on every scroll region inside an overlay
  (Dialog, Drawer, Sheet, DropdownMenu, Command palette, map toolbar).
  Without it, hitting the end of the inner scroll chains to the
  document behind, which scrolls the page underneath the modal —
  surprising and unwanted. The default class for any inner scroll
  region is `overflow-y-auto overscroll-contain`. UI primitives in
  `src/components/ui/` already carry this; callsites that add their
  own inner scroll div (e.g. `routes/data.tsx`'s mobile sidebar) need
  to add it explicitly.
- **Edge fades for horizontal-scroll tables**: `TableShell` in
  `routes/data.tsx` shows a 32px `bg-gradient` fade at the start/end
  edge when there's content past the edge; reaching the end
  dissolves the fade so the last column doesn't sit behind a
  permanent smear. Pattern: a `useLayoutEffect` measures
  `scrollLeft`/`clientWidth`/`scrollWidth` on scroll + `ResizeObserver`
  and toggles `opacity-0`/`opacity-100` on two absolutely-positioned
  gradient overlays. Logical positioning (`start-0`/`end-0`) plus
  `rtl:bg-gradient-to-*` keeps the gradient direction correct in
  both LTR and RTL.

## Icon button accessibility

- Every icon-only `Button` (`size="icon"`) or icon-only `<button>` must
  carry both `title=` and `aria-label=` so the action is announced by
  screen readers and shown as a tooltip on hover. A `title` alone is
  not an accessible name — VoiceOver/NVDA ignore it.
- Use the shared `common.*` i18n keys for the standard actions so the
  tooltip and aria-label stay in sync across locales:
  `common.edit`, `common.delete`, `common.copy`, `common.remove`,
  `common.enable`, `common.disable`. Per-feature labels (e.g.
  `integrations.records.history`, `integrations.tables.removeField`)
  are fine when the action is more specific than the generic verb.
- Pattern (icon button with matching tooltip + accessible name):
  ```tsx
  <Button variant="ghost" size="icon" className="h-7 w-7"
    onClick={onEdit}
    title={t('common.edit', { defaultValue: 'Edit' })}
    aria-label={t('common.edit', { defaultValue: 'Edit' })}>
    <Pencil className="w-3.5 h-3.5" />
  </Button>
  ```
- For toggle buttons with on/off iconography (e.g. `Power` / `PowerOff`
  in `rules-section.tsx`), compute the label from state and use the
  same string for `title`, `aria-label`, and `aria-pressed`:
  ```tsx
  const toggleLabel = rule.enabled
    ? t('common.disable', { defaultValue: 'Disable' })
    : t('common.enable', { defaultValue: 'Enable' })
  <button title={toggleLabel} aria-label={toggleLabel} aria-pressed={rule.enabled}>
  ```
- **Alternative: `sr-only` span.** Some icon buttons (e.g. the action
  row in `routes/files.tsx`) use a visible `<span className="sr-only">`
  inside the button instead of `aria-label`. This is also a valid
  accessible name — pick one pattern per component and stick with it.
  Don't add both; the redundancy confuses screen readers.
- Per-feature labels live under their own top-level section, not under
  `common`. Examples: `schemaBuilder.editField`, `modelEditor.duplicate`,
  `styleRules.editRule` / `styleRules.deleteRule` /
  `styleRules.enableRule` / `styleRules.disableRule`,
  `dataLink.replay.stop`, `integrations.import.removeFromHistory`,
  `integrations.tables.removeField`, `integrations.rules.confirmDelete`.
  Each key was added to all six locale files (en, es, fr, de, ar, zh).

## Don't introduce these

- Redux, Recoil, Jotai (we have Zustand).
- React Query / SWR (we have `useApiQuery` + `spatial-store`).
- Styled Components, Emotion (we have Tailwind + shadcn).
- Axios (we have `api-client.ts`).
- Material UI, Chakra (we have Radix + shadcn).
- Moment.js (use `Date` + `Intl.DateTimeFormat`).

## Solutions (`?solution=` scoping)

- A Solution is a group of existing items inside a workspace (`lib/solutions-client.ts`, backend `handlers/solutions.go`). It is **not** a tenant layer — never add per-solution permissions or data copies.
- A list page joins in by reading `useActiveSolution()` and filtering: server-paged lists pass `solution` to the API (`listWarehouseSummaries`, the `data-screen-client` fetchers — include the id in the cache key); client-side lists filter by `solution.zoneIds` / `reportIds` / `dataSourceIds`. Give it a solution-aware description and empty state, and make "create" from inside a solution add the new item (`addSolutionItems`).
- Links into a solution page use `solutionPath(id, tab)`; the sidebar, breadcrumb and `SolutionScopeBar` read `useSolutionLocation()` — don't parse the URL again.
- Solution icons come from the curated `SOLUTION_ICONS` (`lib/solution-templates.ts`), not `lucide-icons.ts` — the sidebar renders them on every page and the full Lucide map is huge.

## Report export (`src/components/reports/export/`)

- Every writer reads the one `ExportDocument` from `buildExportDocument` — add a new format as a writer over that model, never by reading widget DOM or query results directly (PNG is the only DOM reader, because it is literally a picture of the chart).
- A table widget that has its own view state (search / sort / hidden columns) publishes it with `publishWidgetView` from an effect, so "As on screen" exports match. A new table-like widget should do the same.
- New widget kinds: add them to `DATA_KINDS` / `CHART_KINDS` / `blockType` in `model.ts`, `exportableKinds` in `widget-export-menu.tsx`, and a `reports.export.kind.<kind>` label in all six locales.
- Charts must animate through `useChartMotion` (or read `ReportStaticContext`) so the print view and PNG capture a finished frame.
