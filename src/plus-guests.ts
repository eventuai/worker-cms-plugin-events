export interface PlusGuestAnswer {
  label: string;
  value: string;
}

export interface PlusGuestDetail {
  /** Zero-based position used by compact plus-guest QR payloads. */
  index: number;
  /** One-based position for admin labels. */
  number: number;
  name: string;
  organization: string;
  answers: PlusGuestAnswer[];
  named: boolean;
}

interface ParsedPlusGuest {
  order: number;
  name: string;
  organization: string;
  answers: PlusGuestAnswer[];
}

/**
 * Restores the legacy plus-one response model from the data shapes found on a
 * guest page. Names are optional: `plus_guests` remains the authoritative
 * allowance and any unused slots are returned as anonymous companions.
 */
export function plusGuestDetails(lect: Record<string, unknown>): PlusGuestDetail[] {
  const sources = [
    parseStructuredDetails(lect.plus_guest_details),
    parseResponse(latestPlusGuestResponse(lect.latest_response)),
    parseResponse(asRecord(lect.public_registration)),
    parseResponse(lect),
    parseNameList(lect.plus_guest_names),
  ];
  const merged: ParsedPlusGuest[] = [];

  for (const source of sources) {
    for (let index = 0; index < source.length; index += 1) {
      const incoming = source[index];
      const current = merged[index];
      if (!current) {
        merged[index] = { ...incoming, answers: [...incoming.answers] };
        continue;
      }
      if (!current.name) current.name = incoming.name;
      if (!current.organization) current.organization = incoming.organization;
      const seen = new Set(current.answers.map((answer) => `${answer.label}\u0000${answer.value}`));
      for (const answer of incoming.answers) {
        const key = `${answer.label}\u0000${answer.value}`;
        if (!seen.has(key)) current.answers.push(answer);
        seen.add(key);
      }
    }
  }

  const rawCount = Number.parseInt(String(lect.plus_guests ?? ''), 10);
  const count = Math.max(Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0, merged.length);
  return Array.from({ length: count }, (_, index) => {
    const detail = merged[index];
    const name = detail?.name.trim() ?? '';
    const organization = detail?.organization.trim() ?? '';
    return {
      index,
      number: index + 1,
      name,
      organization,
      answers: detail?.answers ?? [],
      named: Boolean(name),
    };
  });
}

function latestPlusGuestResponse(value: unknown): Record<string, unknown> {
  const responses = Object.values(asRecord(value)).filter(isRecord);
  const withPlusGuests = responses.filter((response) => Object.keys(response).some((key) => key.startsWith('rsvp-plus-one-')));
  const candidates = withPlusGuests.length > 0 ? withPlusGuests : responses;
  return [...candidates].sort((left, right) => responseTime(left) - responseTime(right)).at(-1) ?? {};
}

function responseTime(response: Record<string, unknown>): number {
  const time = Date.parse(String(response.submitted_at ?? ''));
  return Number.isFinite(time) ? time : 0;
}

function parseResponse(response: Record<string, unknown>): ParsedPlusGuest[] {
  const grouped = new Map<string, ParsedPlusGuest>();
  let nextOrder = 0;
  const get = (identity: string): ParsedPlusGuest => {
    const existing = grouped.get(identity);
    if (existing) return existing;
    const created = { order: identityOrder(identity, nextOrder), name: '', organization: '', answers: [] };
    nextOrder += 1;
    grouped.set(identity, created);
    return created;
  };

  for (const [key, rawValue] of Object.entries(response)) {
    const match = key.match(/^(rsvp-plus-one-([^:]+)):(.+)$/i);
    if (!match) continue;
    const guest = get(match[2]);
    const field = match[3];
    const value = displayValue(rawValue);
    if (field === 'name') guest.name = value;
    else if (field === 'organization') guest.organization = value;
    else if (value) guest.answers.push({ label: humanLabel(field), value });
  }

  // Legacy public forms use a hash key whose value maps answer fields back to
  // a nested plus-one block, e.g. x123 = rsvp-plus-one-1:rsvp-meal-abc.
  for (const [mappingKey, rawTarget] of Object.entries(response)) {
    const target = String(rawTarget ?? '');
    const match = target.match(/^rsvp-plus-one-([^:]+):(.+)$/i);
    if (!match) continue;
    const guest = get(match[1]);
    for (const [key, rawValue] of Object.entries(response)) {
      if (!key.startsWith(`${mappingKey}-`)) continue;
      const value = displayValue(rawValue);
      if (!value) continue;
      const field = key.slice(mappingKey.length + 1);
      guest.answers.push({ label: `${humanLabel(match[2])} — ${humanLabel(field)}`, value });
    }
  }

  return [...grouped.values()]
    .filter((guest) => guest.name || guest.organization || guest.answers.length > 0)
    .sort((left, right) => left.order - right.order);
}

function parseStructuredDetails(value: unknown): ParsedPlusGuest[] {
  const rows = Array.isArray(value) ? value : Object.values(asRecord(value));
  return rows.filter(isRecord).map((row, index) => {
    const answers: PlusGuestAnswer[] = [];
    collectAnswers(row, '', answers, new Set(['name', 'organization', 'company']));
    return {
      order: index,
      name: displayValue(row.name),
      organization: displayValue(row.organization ?? row.company),
      answers,
    };
  }).filter((guest) => guest.name || guest.organization || guest.answers.length > 0);
}

function parseNameList(value: unknown): ParsedPlusGuest[] {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|,/) : [];
  return rows.map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      order: index,
      name: displayValue(isRecord(row) ? record.name : row),
      organization: displayValue(record.organization ?? record.company),
      answers: [],
    };
  }).filter((guest) => guest.name || guest.organization);
}

function collectAnswers(value: unknown, prefix: string, answers: PlusGuestAnswer[], excluded: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectAnswers(entry, `${prefix}${prefix ? ' ' : ''}${index + 1}`, answers, excluded));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (!prefix && excluded.has(key)) continue;
      collectAnswers(entry, `${prefix}${prefix ? ' — ' : ''}${humanLabel(key)}`, answers, excluded);
    }
    return;
  }
  const text = displayValue(value);
  if (text && prefix) answers.push({ label: prefix, value: text });
}

function identityOrder(identity: string, fallback: number): number {
  const match = identity.match(/(\d+)(?!.*\d)/);
  return match ? Number.parseInt(match[1], 10) : 10_000 + fallback;
}

function humanLabel(value: string): string {
  const label = value
    .replace(/^rsvp-/, '')
    .replace(/-[a-f0-9]{8,}$/i, '')
    .replace(/[-_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Answer';
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
  if (isRecord(value)) return Object.values(value).map(displayValue).find(Boolean) ?? '';
  return String(value).trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
