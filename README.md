# worker-cms-plugin-events (Events Suite)

A [Worker CMS](https://github.com/zeroxcms) plugin covering the whole **event
side** of the system in one Worker — **events + RSVP + EDM (email) + QR codes** —
to stay within the Cloudflare **Free plan** (50 subrequests/request, 100k
requests/day): one plugin = one cross-Worker hop instead of four.

Part of the RSVP/contact port — see `cms/../cms-to-rsvp.md`. Pairs with
`cms-plugin-contacts` (the other suite). Replaces the former standalone
`cms-plugin-rsvp`, `cms-plugin-edm`, and `cms-plugin-qrcodes` repos.

## Registers (manifest id `events`)

The manifest is a static file — [`src/manifest.json`](src/manifest.json) — served
verbatim at `/__plugin/manifest` (imported into `src/index.ts`), rather than being
assembled from constants. Edit the JSON to change content types, blocks, nav, etc.

- **Blueprints:** `event` (sessions, capacity, RFID, kiosk), `guest`, `label`,
  `edm`, `mail_list`, `mail_preview_list`.
- **Taxonomies:** `event-type` and `event-categories` shown on `event` pages.
- **Event grouping:** `edm` and `mail_list` pages belong to an event via their
  `lect._pointers.event` (their CMS parent page may be a different page type), so
  the plugin lists them with `listByEvent()` and filters on that pointer rather
  than the parent `page_id`. Guests still parent under their `mail_list`.
- **Blocks + block lists:** content blocks, EDM blocks, all `rsvp-*` blocks;
  `events` / `edm` / `rsvp` block lists.
- **Nav (3 items):** Events, RSVP, EDM — each a section of the same plugin admin.
- **Page views:** `editViews: ['edm', 'guest']`, `newViews: ['event']` — EDM and
  guest pages open bespoke editors, and new event pages open a simple event setup
  view before falling back to the CMS editor for existing events. See [EDM editor](#edm-editor).
- **Hooks:** `publish`, `unpublish`, `delete`.
- **Public routes (own domain):** `/qr` + `/sign` (signed QR). The guest-facing
  RSVP form lives in the standalone [`worker-rsvp`](../worker-rsvp) Worker —
  this plugin mints its signed links (`PUBLIC_BASE_URL` points there, and
  worker-rsvp verifies them with a copy of this plugin's `PLUGIN_SECRET`).
  Check-in lives in `cms-plugin-checkin`; EDM unsubscribe is TODO.

## EDM editor

Because the manifest lists plugin page-view overrides, the CMS hands the whole
edit/new view for configured page types to this plugin: it `POST`s the editor context to
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

## Email delivery setup

EDM sending has two interchangeable backends. `deliverQueuedEmail`
([`src/edm.ts`](src/edm.ts)) picks one per send:

1. **AWS SES** — used whenever `AWS_SES_REGION` + `AWS_ACCESS_KEY_ID` +
   `AWS_SECRET_ACCESS_KEY` are all set (takes precedence over the binding).
2. **Cloudflare Email Service** — the `EMAIL` (`[[send_email]]`) binding,
   used otherwise.

Either way `EMAIL_FROM` is the default sender; an EDM's own **Sender email**
field overrides it per-EDM. With neither backend configured, sends fail with a
config-hint error. To switch backends, add or remove the SES credentials —
there is no separate toggle.

### Option A — Cloudflare Email Service

Only works when the sender domain's DNS is hosted **on Cloudflare** (the
service verifies the sender there). Uncomment in `wrangler.toml`:

```toml
[[send_email]]
name = "EMAIL"

[vars]
EMAIL_FROM = "events@example.com"
```

### Option B — AWS SES (any DNS host)

Ported from the legacy eventuai admin (`config/mail.mjs`), so its verified SES
identities carry over. [`src/ses.ts`](src/ses.ts) calls the SES v2 `SendEmail`
API with a WebCrypto SigV4 signature — no AWS SDK. The IAM key needs
`ses:SendEmail`; verify the sender identity in SES first.

```bash
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
```

```toml
[vars]
AWS_SES_REGION = "ap-southeast-1"
AWS_SES_CONFIGURATION_SET = "default"   # optional: bounce/open tracking
EMAIL_FROM = "events@example.com"
```

Local dev: put the same values in `.dev.vars` (gitignored). Optional
`AWS_SESSION_TOKEN` supports temporary STS credentials; `AWS_SES_ENDPOINT`
overrides the API endpoint (tests).

### Blasts, scheduling, and per-tenant senders

- **Guest-list blasts** additionally need the `MAIL_QUEUE` queue
  (producer + consumer), and **scheduled blasts** the cron trigger — see the
  commented blocks in [`wrangler.toml`](wrangler.toml). Test sends
  (EDM editor → send-test) work without the queue.
- **Multi-tenant:** all of the above are plain env vars, and each TENANTS
  record's `vars` overlay the env before delivery — so one tenant can carry its
  own `AWS_SES_*` / `EMAIL_FROM` (e.g. route only that tenant through a
  different SES account, or mix backends across tenants). Tenant vars overlay
  last and win.
- **Verify** with the EDM editor's test-send: SES deliveries arrive with
  `X-SES-*` headers; misconfiguration surfaces the backend's own error in the
  admin panel (e.g. SES "Email address is not verified").

## Status

- [x] All event/RSVP/EDM blueprints + blocks + block lists + event taxonomies;
      3-section admin
- [x] Signed QR `/qr` + `/sign` (real QR matrix, HMAC via Web Crypto)
- [x] Bespoke EDM and guest editors plus a new-event setup view as plugin page views
- [x] Guest lists, guest management, CSV import/export, label designer
- [x] Signed RSVP links (multilingual, `?edm=`) — the form itself is served by
      the standalone `worker-rsvp` Worker from the published DB
- [x] Render/send email, scheduled blasts (code done — provision the
      `wrangler.toml` email/queue/cron/KV bindings before enabling delivery)
- [x] Add/remove guests from the contact database (per-list Contacts page;
      reads `contact` pages via manifest `readTypes`)
- [x] Event archive (guest↔contact reconciliation review + archived flag;
      archived events hidden from the index)
- [x] EDM unsubscribe links (per-recipient `{{unsubscribe_url}}` token;
      the route itself is served by worker-rsvp)
- [ ] RSVP response storage (submits keep the interim draft-guest update)
- [ ] Contact `event_history` write-back on archive (events plugin is
      read-only on `contact` pages — belongs to the contacts plugin)

## Source mapping

`controller/admin/{Event,Lead,RSVP,Edm}.mjs`, `controller/{RSVP,QRCode,Cron}.mjs`,
`config/cms.mjs`, `config/mail.mjs`.
