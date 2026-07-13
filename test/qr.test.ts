import { describe, expect, it } from 'vitest';
import { qrMatrix, qrMetadata, qrSvg, qrTicketSvg } from '../src/qr';
import { compactCheckinCode } from '../src/crypto';

describe('qr encoder', () => {
  it('uses @verevoir/qrcode with at least ECC level Q for compact codes', () => {
    const metadata = qrMetadata(compactCheckinCode(21996952637102, 22012755208409));
    expect(['Q', 'H']).toContain(metadata.errorLevel);
    expect(metadata.version).toBeGreaterThan(0);
    expect(metadata.size).toBe(metadata.version * 4 + 17);
  });

  it('encodes the compact legacy Eventuai check-in payload in radix 32 with BLAKE3', () => {
    expect(compactCheckinCode(19856682903287, 19856712108462)).toBe(
      `EAI${(19856682903287).toString(32)}:${(19856712108462 - 19856682903287).toString(32)}:M:cc7560`,
    );
    expect(compactCheckinCode(100, 125, 0)).toMatch(/^EAI34:p:0:[0-9a-f]{6}$/);
  });

  it('picks the smallest version that fits and is square', () => {
    const small = qrMatrix('HELLO');
    expect(small.length).toBe(21); // version 1 → 21×21
    expect(small.every((row) => row.length === 21)).toBe(true);

    const url = qrMatrix('https://events.example.com/checkin/12345/67890/ab12cd34ef5678');
    expect((url.length - 17) % 4).toBe(0); // valid QR side = 4*version+17
    expect(url.length).toBeGreaterThan(21);
  });

  it('places the three finder patterns and timing rows', () => {
    const m = qrMatrix('finder-check');
    const n = m.length;
    // Finder cores are dark, their inner separators light.
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      expect(m[r][c]).toBe(true);
      expect(m[r + 3][c + 3]).toBe(true); // 3×3 centre
      expect(m[r + 1][c + 1]).toBe(false); // ring gap
    }
    // Timing pattern alternates along row/column 6.
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
  });

  it('is deterministic and supports payloads beyond the old version-10 limit', () => {
    expect(JSON.stringify(qrMatrix('same'))).toBe(JSON.stringify(qrMatrix('same')));
    expect(qrMatrix('x'.repeat(500)).length).toBeGreaterThan(57);
  });

  it('renders an SVG with a quiet zone and module rects', () => {
    const svg = qrSvg('HI', { size: 200, margin: 4 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('<rect'); // background + modules
    // viewBox accounts for the 4-module quiet zone on each side (21 + 8 = 29).
    expect(svg).toContain('viewBox="0 0 29 29"');
  });

  it('renders a legacy-style ticket with escaped, wrapped guest text', () => {
    const svg = qrTicketSvg('EAI123:ABC', {
      keyword: 'HKDC Vividly Hong Kong',
      name: 'Elliott <Tse> with a deliberately very long attendee name that wraps',
      organization: 'Occasions & Asia Pacific 國際活動公司',
    });
    expect(svg).toContain('width="320"');
    expect(svg).toContain('HKDC Vividly Hong Kong');
    expect(svg).toContain('Elliott &lt;Tse&gt;');
    expect(svg).toContain('Occasions &amp; Asia Pacific');
    expect((svg.match(/<svg/g) ?? [])).toHaveLength(1);
    // Ticket QR uses the standard four-module quiet zone for scanner reliability.
    expect(svg).toContain('translate(20 10)');
    expect((svg.match(/<text /g) ?? []).length).toBeGreaterThan(3);
    expect(svg).not.toContain('deliberately very long attendee name that wraps</text>');
  });
});
