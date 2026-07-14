import { describe, expect, it } from 'vitest';
import { computeGuestListSummary, guestAttendance, type CmsPage } from '../src/cms';
import { plusGuestDetails } from '../src/plus-guests';

describe('plus guest details', () => {
  it('parses names, organizations and nested legacy response answers while retaining anonymous slots', () => {
    const details = plusGuestDetails({
      plus_guests: '2',
      latest_response: {
        old: { submitted_at: '2026-01-01', 'rsvp-plus-one-1:name': 'Old name' },
        current: {
          submitted_at: '2026-02-01',
          'rsvp-plus-one-1:name': 'Charles Babbage',
          'rsvp-plus-one-1:organization': 'Difference Engine Ltd',
          'rsvp-plus-one-1:diet': 'Vegetarian',
          xmeal: 'rsvp-plus-one-1:rsvp-meal-preferences-deadbeef',
          'xmeal-food': 'No shellfish',
        },
      },
    });

    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({
      index: 0,
      number: 1,
      sourceKey: 'rsvp-plus-one-1',
      name: 'Charles Babbage',
      organization: 'Difference Engine Ltd',
      named: true,
      answers: [
        { label: 'Diet', value: 'Vegetarian' },
        { label: 'Meal preferences — Food', value: 'No shellfish' },
      ],
    });
    expect(details[1]).toMatchObject({ index: 1, number: 2, name: '', named: false });
  });

  it('accepts structured companion details and keeps their nested answers', () => {
    const details = plusGuestDetails({
      plus_guest_details: [{
        name: 'Grace Hopper',
        organization: 'US Navy',
        meal: { preference: 'Vegan' },
      }],
    });

    expect(details).toEqual([{
      index: 0,
      number: 1,
      sourceKey: 'structured-1',
      name: 'Grace Hopper',
      organization: 'US Navy',
      named: true,
      answers: [{ label: 'Meal — Preference', value: 'Vegan' }],
    }]);
  });

  it('returns only anonymous slots after named companions are materialized', () => {
    const details = plusGuestDetails({
      plus_guests: '1',
      companion_model: 'linked-v1',
      companion_links: [{ guest_id: 44, source_key: 'rsvp-plus-one-1', name: 'Grace Hopper' }],
      latest_response: { latest: { 'rsvp-plus-one-1:name': 'Grace Hopper' } },
    });

    expect(details).toEqual([{
      index: 0,
      number: 1,
      sourceKey: 'anonymous-1',
      name: '',
      organization: '',
      named: false,
      answers: [],
    }]);
  });
});

describe('guest attendance', () => {
  it('separates main, companion and session attendance', () => {
    expect(guestAttendance({
      checkin: [
        { status: 'checked-in', message: 'main attendee checked-in at front desk' },
        { status: 'checked-in', message: 'plus guest 1 ("Charles") checked-in at front desk' },
        { status: 'checked-in', message: 'session keynote "Opening" checked-in at door' },
      ],
    })).toEqual({ mainCheckedIn: true, plusCheckedIn: 1, totalCheckedIn: 2 });
  });

  it('does not treat a companion-only check-in as the main guest', () => {
    expect(guestAttendance({
      checkin: [{ status: 'checked-in', message: 'plus guest 2 checked-in at front desk' }],
    })).toEqual({ mainCheckedIn: false, plusCheckedIn: 1, totalCheckedIn: 1 });
  });

  it('uses actual attendee check-ins for dashboard totals', () => {
    const guest = {
      id: 1,
      page_type: 'guest',
      page_id: 8,
      name: 'Ada',
      lect: {
        status: 'confirmed',
        plus_guests: '2',
        checkin: [{ status: 'checked-in', message: 'plus guest 1 checked-in at front desk' }],
      },
    } as unknown as CmsPage;

    expect(computeGuestListSummary([guest])).toMatchObject({
      guest_count: 1,
      guest_total: 3,
      checked_in_count: 1,
      checked_in_total: 1,
    });
  });
});
