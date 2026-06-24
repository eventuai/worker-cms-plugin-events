# worker-cms-plugin-events (Events Suite)

A [Worker CMS](https://github.com/zeroxcms) plugin covering the whole **event
side** of the system in one Worker — **events + RSVP + EDM (email) + QR codes** —
to stay within the Cloudflare **Free plan** (50 subrequests/request, 100k
requests/day): one plugin = one cross-Worker hop instead of four.

Part of the RSVP/contact port — see `cms/../cms-to-rsvp.md`. Pairs with
`cms-plugin-contacts` (the other suite). Replaces the former standalone
`cms-plugin-rsvp`, `cms-plugin-edm`, and `cms-plugin-qrcodes` repos.

## Registers (manifest id `events`)

- **Blueprints:** `event` (sessions, capacity, RFID, kiosk), `guest`, `label`,
  `edm`, `mail_list`, `mail_preview_list`.
- **Blocks + block lists:** content blocks, EDM blocks, all `rsvp-*` blocks;
  `events` / `edm` / `rsvp` block lists.
- **Nav (3 items):** Events, RSVP, EDM — each a section of the same plugin admin.
- **Edit view:** `editViews: ['edm']` — `edm` pages open the bespoke EDM editor
  (ported from the legacy Eventuai admin) instead of the CMS's generic structured
  editor. See [EDM editor](#edm-editor).
- **Hooks:** `publish`, `unpublish`, `delete`.
- **Public routes (own domain):** `/qr` + `/sign` (signed QR, live); RSVP forms,
  check-in, and EDM unsubscribe are TODO.

## EDM editor

Because the manifest lists `editViews: ['edm']`, the CMS hands the whole edit/new
view for an `edm` page to this plugin: it `POST`s the editor context to
`/__plugin/edit`, and the plugin returns the bespoke EDM editor
([`src/edm.ts` → `handleEdmEditView`](src/edm.ts),
[`views/sections/edm-edit.liquid`](views/sections/edm-edit.liquid)) as an HTML
fragment the CMS wraps in its admin chrome. The design follows the legacy
Eventuai admin: template name, sender/styling, subject/headline/body, a content-
block builder, RSVP/thank-you/decline settings, an email-preview iframe, and a
test-send form.

The preview pane embeds `GET /__plugin/admin/edm/:id/preview?language=<lang>` in a
same-origin `<iframe>`. That preview route sets `x-cms-frame: 1`, which the CMS
proxy turns into `X-Frame-Options: SAMEORIGIN` (admin pages are `DENY` by default,
which is what otherwise blocks the embed). Per-language tabs above the iframe
retarget it (plain anchors with `target="edm-preview"`, no client JS), and the
selected editor language drives the initial preview language.

The editor's single `<form>` posts back to the CMS's normal save handler using
the CMS field-name conventions (`@attr`, `.field|<lang>`, `*event`, `#<block>…`,
and the `block-add` / `block-delete` / `block-item-*` actions), so save,
versioning and publish all flow through the CMS unchanged. The language selector
sits in the Email-content card (like the CMS page editor) as a `_language` field
marked `data-autosubmit`, so changing it reloads the page in that language — the
CMS layout's nonce'd script auto-submits the form (a CSP-safe replacement for an
inline `onchange`). Markup uses only the
Tailwind utilities the host CMS emits (it borrows the host's `admin.css`), and
collapsibles use native `<details>` rather than purged `peer-checked:*` classes.
Returning `404` (any non-`edm` page, or an unconfigured CMS link) makes the CMS
fall back to its built-in editor.

## Develop

```bash
npm install && npm run dev
```

## Register into the CMS (D1 URL transport — no service binding)

1. `wrangler deploy` this Worker, then `wrangler secret put PLUGIN_SECRET`.
2. In the CMS: **Admin → Plugins → Register plugin**, paste this Worker's base URL.
   (Requires the `plugin:manage` permission and the same `PLUGIN_SECRET` on the CMS.)

No `wrangler.toml` change or CMS redeploy needed.

## Status

- [x] All event/RSVP/EDM blueprints + blocks + block lists; 3-section admin
- [x] Signed QR `/qr` + `/sign` (HMAC via Web Crypto; image is a placeholder)
- [x] Bespoke EDM editor as a plugin edit view (`editViews: ['edm']`)
- [ ] Guest lists, label designer, public check-in (events)
- [ ] Guest management, public RSVP form + submit → write-back F1 (rsvp)
- [ ] Render/send email, scheduled blasts (edm — bindings stubbed in `wrangler.toml`)
- [ ] Real QR matrix render

## Source mapping

`controller/admin/{Event,Lead,RSVP,Edm}.mjs`, `controller/{RSVP,QRCode,Cron}.mjs`,
`config/cms.mjs`, `config/mail.mjs`.
