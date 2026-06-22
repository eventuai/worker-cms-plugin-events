# worker-cms-plugin-events

A [Worker CMS](https://github.com/zeroxcms) plugin for **events** — event pages,
guest lists, label printing and (planned) public check-in.

Part of the RSVP/contact port — see `cms/../cms-to-rsvp.md`.

## Registers

- **Blueprints:** `event` (sessions, capacity, RFID, kiosk, custom inputs),
  `guest`, `label`.
- **Blocks + block list:** generic content blocks and the `events` block list.
- **Hooks:** `publish`, `unpublish`, `delete`.
- **Nav + admin page** proxied at `/admin/plugins/events/*`.

## Develop

```bash
npm install && npm run dev
```

## Bind into the CMS

```toml
[[services]]
binding = "PLUGIN_EVENTS"
service = "cms-plugin-events"

[vars]
PLUGINS = "PLUGIN_EVENTS"
```

## Status

- [x] `event` / `guest` / `label` blueprints + blocks + `events` block list
- [x] Admin dashboard, lifecycle hooks
- [ ] Guest lists, reorder, export/import, "all guests", archive
- [ ] Label designer (SVG templates, save/load)
- [ ] Public check-in (adhoc / RFID / kiosk) on own domain + write-back (F1)

## Source mapping

`controller/admin/Event.mjs`, `controller/admin/Lead.mjs`, `controller/QRCode.mjs`.
