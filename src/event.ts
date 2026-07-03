import { attr } from './cms';
import { clientViewResponse } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';

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
