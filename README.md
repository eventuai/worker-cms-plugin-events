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
- **Hooks:** `publish`, `unpublish`, `delete`.
- **Public routes (own domain):** `/qr` + `/sign` (signed QR, live); RSVP forms,
  check-in, and EDM unsubscribe are TODO.

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
- [ ] Guest lists, label designer, public check-in (events)
- [ ] Guest management, public RSVP form + submit → write-back F1 (rsvp)
- [ ] Render/send email, scheduled blasts (edm — bindings stubbed in `wrangler.toml`)
- [ ] Real QR matrix render

## Source mapping

`controller/admin/{Event,Lead,RSVP,Edm}.mjs`, `controller/{RSVP,QRCode,Cron}.mjs`,
`config/cms.mjs`, `config/mail.mjs`.
