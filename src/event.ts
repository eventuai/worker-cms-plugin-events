import { attr, type CmsClient, type CmsPage, listByEvent } from './cms';
import { clientViewResponse } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';
const RSVP_SAMPLE_NAME = 'Sample RSVP EDM';
const QR_SAMPLE_NAME = 'Sample QR code confirmation EDM';

interface EditViewContext {
  mode: 'new' | 'edit';
  action: string;
  backHref: string;
  pageType: string;
  page: {
    id: number | string;
    name: string;
    slug: string;
    pageType: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    lect: string;
  };
  flash?: string;
  errors?: string[];
}

const TIMEZONE_OPTIONS = [
  { value: '+0800', label: 'Hong Kong (UTC+08:00)' },
  { value: '+0000', label: 'UTC' },
  { value: '+0700', label: 'UTC+07:00' },
  { value: '+0900', label: 'UTC+09:00' },
  { value: '+1000', label: 'UTC+10:00' },
  { value: '-0500', label: 'UTC-05:00' },
  { value: '-0800', label: 'UTC-08:00' },
];

const EVENT_USE_CASES = [
  {
    value: 'manual_qr_single',
    label: 'Guest list, single session, manually send QR code for checkin',
  },
  {
    value: 'rsvp_qr_single',
    label: 'Guest lists, single session, send RSVP, QR code confirmation',
  },
  {
    value: 'rsvp_plus_one',
    label: 'Guest lists, single session, send RSVP, QR code for plus one guests',
  },
  {
    value: 'multi_session_labels',
    label: 'Guest lists, multi session, send RSVP, QR code confirmation, Label Printing',
  },
  {
    value: 'multi_session_rfid',
    label: 'Guest lists with multiple session, send RSVP, QR code confirmation, Label Printing with RFID tracking',
  },
];

export async function handleEventEditView(request: Request): Promise<Response> {
  const ctx = (await request.json().catch(() => null)) as EditViewContext | null;
  if (!ctx || ctx.pageType !== 'event' || ctx.mode !== 'new') return new Response('not found', { status: 404 });

  const lect = parseLect(ctx.page.lect);
  const timezone = ctx.page.timezone || '+0800';
  const selectedUseCase = attr(lect, 'event_use_case') || EVENT_USE_CASES[0].value;

  return clientViewResponse('New event', '/sections/event-new.liquid', {
    action: ctx.action,
    backHref: ctx.backHref || `${ADMIN_BASE}/events`,
    flash: ctx.flash ?? '',
    errors: ctx.errors ?? [],
    name: ctx.page.name,
    slug: ctx.page.slug,
    weight: ctx.page.weight,
    start: toDatetimeLocal(ctx.page.start),
    end: toDatetimeLocal(ctx.page.end),
    timezone,
    timezoneOptions: TIMEZONE_OPTIONS.map((option) => ({ ...option, selected: option.value === timezone })),
    useCases: EVENT_USE_CASES.map((option) => ({ ...option, selected: option.value === selectedUseCase })),
  });
}

export async function createSampleEdmsForEvent(cms: CmsClient, eventId: number): Promise<void> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return;

  const useCase = attr(event.lect, 'event_use_case');
  const samples = sampleEdmsForUseCase(event, useCase);
  if (samples.length === 0) return;

  const existing = await listByEvent(cms, 'edm', event.id);
  const existingKeys = new Set(existing.map((edm) => `${attr(edm.lect, 'sample_kind') || edm.name}`));
  for (const sample of samples) {
    if (existingKeys.has(sample.kind) || existingKeys.has(sample.name)) continue;
    await cms.create({
      page_type: 'edm',
      name: sample.name,
      lect: sample.lect,
    });
  }
}

function sampleEdmsForUseCase(event: CmsPage, useCase: string): Array<{ kind: string; name: string; lect: Record<string, unknown> }> {
  const samples: Array<{ kind: string; name: string; lect: Record<string, unknown> }> = [];
  if (createsRsvpSample(useCase)) samples.push(sampleRsvpEdm(event));
  if (createsQrSample(useCase)) samples.push(sampleQrEdm(event));
  return samples;
}

function createsRsvpSample(useCase: string): boolean {
  return new Set(['rsvp_qr_single', 'rsvp_plus_one', 'multi_session_labels', 'multi_session_rfid']).has(useCase);
}

function createsQrSample(useCase: string): boolean {
  return new Set(['manual_qr_single', 'rsvp_qr_single', 'rsvp_plus_one', 'multi_session_labels', 'multi_session_rfid']).has(useCase);
}

function sampleRsvpEdm(event: CmsPage): { kind: string; name: string; lect: Record<string, unknown> } {
  const name = RSVP_SAMPLE_NAME;
  return {
    kind: 'sample-rsvp',
    name,
    lect: {
      _type: 'edm',
      sample_kind: 'sample-rsvp',
      name: { en: name },
      subject: { en: `RSVP for ${event.name}` },
      heading: { en: `You're invited to ${event.name}` },
      body: { en: 'Hi {{prefer_name||name}},<br><br>Please let us know if you can join us.' },
      rsvp_button: { en: 'RSVP now' },
      rsvp_form_button: { en: 'Confirm RSVP' },
      rsvp_form_decline_button: { en: 'Decline' },
      thankyou_heading: { en: 'Thank you for your RSVP' },
      thankyou_body: { en: 'We have received your response.' },
      decline_heading: { en: 'Thank you for letting us know' },
      decline_body: { en: 'We are sorry you cannot join us this time.' },
      quick_confirm: 'yes',
      _pointers: { event: String(event.id) },
    },
  };
}

function sampleQrEdm(event: CmsPage): { kind: string; name: string; lect: Record<string, unknown> } {
  const name = QR_SAMPLE_NAME;
  return {
    kind: 'sample-qr',
    name,
    lect: {
      _type: 'edm',
      sample_kind: 'sample-qr',
      name: { en: name },
      subject: { en: `QR code confirmation for ${event.name}` },
      heading: { en: 'Your QR code confirmation' },
      body: {
        en: 'Hi {{prefer_name||name}},<br><br>Your RSVP is confirmed. Please bring this QR code or code with you for check-in:<br><br><strong>{{qrcode||barcode||rsvp_code}}</strong>',
      },
      rsvp_button: { en: 'View RSVP' },
      _pointers: { event: String(event.id) },
    },
  };
}

function parseLect(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return '';
  return value.slice(0, 16);
}
