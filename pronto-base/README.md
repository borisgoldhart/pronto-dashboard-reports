# Pronto Base

Shared page template + top navigation for Pronto tools. One hosted package, loaded by every page, updated centrally.

## Quick start

Add one tag to any page:

```html
<script src="https://<host>/base/v1/loader.js"
        data-page-title="My Tool"
        data-subtitle="Reporting"
        data-active="home"></script>
```

That injects the base CSS, registers `<pronto-nav>` + `<pronto-banner>`, and mounts them at the top of `<body>`. Add your tool's own CSS/JS after it.

Richer config — set **before** the loader tag:

```html
<script>
  window.ProntoPage = {
    pageTitle: "Ops Dashboard - Lewis",
    subtitle: "Dashboard",
    pageInfo: "Tooltip for the (i) icon",
    active: "projects",                       // home|inbox|projects|starred|timesheets|apps
    appRoot: "https://havaspronto.com",       // prefix for relative nav links
    user: { name: "Lewis Lowery", avatarUrl: "", href: "/profile" },
    homepage: { label: "My Homepage", href: "#", checked: true,   // false = hide
      menu: { sections: [{ items: [{ label: "Duplicate Dashboard", icon: "copy", href: "#" }] }] } },
    // links: [...override the nav items...],
    // menus: { projects: {...} },            // attach a dropdown to a default link by id
    // plusMenu / userMenu: {...} or false,   // override/hide the "+" and avatar menus
    // search: { href, param, placeholder, hidden },
  };
</script>
<script src="https://<host>/base/v1/loader.js"></script>
```

Opt-outs: `data-auto="off"` (no auto-mount — place `<pronto-nav>`/`<pronto-banner>` yourself), `data-banner="off"`, `data-fonts="off"` (skip the Lato injection).

Minimal-chrome mode (single-purpose tools): `links: []` removes the nav items,
`search: { hidden: true }` the search box, `plusMenu: false` / `userMenu: false`
the right-side menus — leaving logo + avatar. Banner breadcrumb:
`breadcrumb: ["App name", "Current page"]` (segments may be `{label, href}`;
earlier segments render dimmed, last is the title) — call `banner.refresh()`
after changing it.

## Dropdown menus

Menus replicate the live Pronto behaviour: click toggles, outside click / Escape closes, one open at a time. Menu definition shape:

```js
{ sections: [{ title: "Explore", items: [{ label, icon, href, iconHtml? }] }],
  footer: [{ label: "View All Projects", href }, { label: "Create Project", href }] }
```

The **Apps**, **"+" (create)** and **avatar** menus ship as package defaults mirroring the live nav (update hrefs centrally as they're confirmed). Personalised menus (Projects "Recently Accessed"/"Starred") are page-supplied via `menus.projects` for now; phase 2 adds `fetchMenu: (id) => Promise<menuDef>` with `menu: "auto"` so the package fetches them itself.

## Measured spec (live havaspronto.com, Jul 2026)

Bar: white, 56px, 40px side padding, logo 200×22 left, items centred, search/+/avatar right. Nav item: 36px tall, 12px side padding, 12px icon + 6px gap, Lato 13px/700 `#18181a`, hover `#f2f2f2` radius 4. Menu panel: white, 1px `#cac9cc`, radius 4, shadow `0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)`; wide nav panels 528px, right-cluster panels 272px; rows 32px, 12px/700 text, 12px icons, section headers 11px/700 uppercase `#666`. Font: Lato (injected by loader). Live icons are Font Awesome Pro; the package ships license-free SVG lookalikes — override per item with `iconHtml`.

## What's in the package

| File | Purpose |
|---|---|
| `v1/loader.js` | One-tag bootstrap: injects CSS + components, auto-mounts |
| `v1/pronto-nav.js` | `<pronto-nav>` + `<pronto-banner>` web components (shadow DOM — page CSS can't break them) |
| `v1/pronto-base.css` | Design tokens (`--pp-*`), page shell, cards, buttons, chips, tabs, inputs, tables (`.pp-*` classes) |
| `v1/img/` | Packaged assets. Logo resolution order: `img/havas-pronto-wide.png` → live havaspronto.com URL → text logo. Override per page with `logoSrc`/`logoHtml`; size via `--pp-logo-h` |
| `demo/index.html` | Reference page recreating the PM dashboard layout |

Tokens pierce the shadow DOM, so a central change to `--pp-red` or `--pp-nav-h` restyles every page and the nav together.

Z-index contract: the sticky nav sits at `z-index: 900`. Page content and in-flow popovers stay below 900; full-screen overlays (drawers, modals, scrims) use **≥ 1000** so they cover the nav.

## Live user data (later)

For v1 each page passes `user` in config. The hook for phase 2 is already in place:

```js
window.ProntoPage = { user: "auto", fetchUser: () => fetch("/api/me").then(r => r.json()) };
```

When a central `/api/me` exists, we move `fetchUser` into the package itself and pages stop passing user info entirely.

## Versioning

`/v1/` is a **channel**: non-breaking changes ship in place and reach every page on next load. Breaking changes go to `/v2/`; pages migrate on their own schedule. If a team ever needs a frozen build, publish pinned copies (`/1.4.2/`) alongside the channel.

## Local dev

Served by the dashboard server at `http://localhost:8787/base/…` (`npm start` in `pronto-dashboard/`). Demo: `http://localhost:8787/base/demo/`.
