import QRCode from '@verevoir/qrcode';
import { Resvg } from '@cf-wasm/resvg';
import { qrTicketFontBuffers } from './qr-fonts';

type ErrorLevel = 'L' | 'M' | 'Q' | 'H';

// Q gives the compact Eventuai token roughly 25% damage recovery. Verevoir may
// boost to H when that stronger level fits without increasing the QR version.
const ERROR_CORRECTION_LEVEL: ErrorLevel = 'Q';

export interface QrMetadata {
  version: number;
  errorLevel: ErrorLevel;
  maskIndex: number;
  size: number;
}

function createQr(text: string) {
  return QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION_LEVEL });
}

/** Builds a standards-compliant matrix using @verevoir/qrcode. */
export function qrMatrix(text: string): boolean[][] {
  return createQr(text).matrix.map((row) => Array.from(row, (cell) => cell === 1));
}

/** Encoding details exposed for regression tests and scanner diagnostics. */
export function qrMetadata(text: string): QrMetadata {
  const qr = createQr(text);
  return { version: qr.version, errorLevel: qr.errorLevel, maskIndex: qr.maskIndex, size: qr.size };
}

export function qrSvg(text: string, { size = 220, margin = 4 }: { size?: number; margin?: number } = {}): string {
  const { count, rects } = qrSvgParts(text, margin);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${count} ${count}" shape-rendering="crispEdges">` +
    `<rect width="${count}" height="${count}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g></svg>`;
}

function qrSvgParts(text: string, margin: number): { count: number; rects: string } {
  const matrix = qrMatrix(text);
  const count = matrix.length + margin * 2;
  const rects: string[] = [];
  for (let row = 0; row < matrix.length; row++) {
    for (let column = 0; column < matrix.length; column++) {
      if (matrix[row][column]) rects.push(`<rect x="${column + margin}" y="${row + margin}" width="1" height="1"/>`);
    }
  }
  return { count, rects: rects.join('') };
}

export interface QrTicketText {
  keyword?: string;
  name?: string;
  organization?: string;
  jobTitle?: string;
  remark?: string;
}

/** Legacy-style check-in ticket with centred, width-wrapped SVG text. */
export function qrTicketSvg(payload: string, fields: QrTicketText, { width = 320, qrSize = 280 }: { width?: number; qrSize?: number } = {}): string {
  const rows: Array<{ value: string; size: number; color: string; weight?: number }> = [];
  add(fields.keyword, 11, '#333');
  add(fields.name, (fields.name?.length ?? 0) > 35 ? 14 : 18, '#000', 400);
  add(fields.organization, 14, '#666');
  add(fields.jobTitle, 11, '#666');
  add(fields.remark, 11, '#999');

  function add(value: string | undefined, size: number, color: string, weight?: number): void {
    const clean = String(value ?? '').trim();
    if (clean) rows.push({ value: clean, size, color, weight });
  }

  const maxTextWidth = width - 20;
  let y = qrSize + 20;
  const textElements: string[] = [];
  for (const row of rows) {
    const lines = wrapSvgText(row.value, maxTextWidth, row.size);
    const lineHeight = Math.ceil(row.size * 1.15);
    for (const line of lines) {
      y += lineHeight;
      textElements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Noto Sans TC,Noto Sans SC,Noto Sans CJK TC,Noto Sans CJK SC,Arial,sans-serif" font-size="${row.size}"${row.weight ? ` font-weight="${row.weight}"` : ''} fill="${row.color}">${escapeSvgText(line)}</text>`);
    }
    y += 7;
  }

  const height = Math.max(qrSize + 20, y + 7);
  const qr = qrSvgParts(payload, 4);
  const scale = qrSize / qr.count;
  const qrGroup = `<g transform="translate(${(width - qrSize) / 2} 10) scale(${scale})" shape-rendering="crispEdges"><rect width="${qr.count}" height="${qr.count}" fill="#fff"/><g fill="#000">${qr.rects}</g></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/>${qrGroup}${textElements.join('')}</svg>`;
}

/** Renders a ticket SVG with a Chinese font that covers both simplified and traditional guest text. */
export async function renderQrTicketPng(
  svg: string,
  fontBuffers: Uint8Array[] = qrTicketFontBuffers,
): Promise<Uint8Array> {
  const renderer = await Resvg.async(svg, {
    background: '#fff',
    font: {
      loadSystemFonts: false,
      fontBuffers,
      defaultFontFamily: 'Noto Sans TC',
      sansSerifFamily: 'Noto Sans TC',
    },
    shapeRendering: 1,
    textRendering: 1,
  });
  const rendered = renderer.render();
  const png = rendered.asPng();
  rendered.free();
  renderer.free();
  return png;
}

function wrapSvgText(value: string, maxWidth: number, fontSize: number): string[] {
  const maxUnits = maxWidth / fontSize;
  const result: string[] = [];
  for (const paragraph of value.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s+|[^\s]+/gu) ?? ['']) {
      const candidate = line + token;
      if (line.trim() && textUnits(candidate) > maxUnits) {
        result.push(line.trim());
        line = token.trimStart();
      } else {
        line = candidate;
      }
      while (textUnits(line) > maxUnits && Array.from(line).length > 1) {
        const chars = Array.from(line);
        let split = 1;
        while (split < chars.length && textUnits(chars.slice(0, split + 1).join('')) <= maxUnits) split++;
        result.push(chars.slice(0, split).join('').trim());
        line = chars.slice(split).join('').trimStart();
      }
    }
    result.push(line.trim());
  }
  return result.filter(Boolean);
}

function textUnits(value: string): number {
  return Array.from(value).reduce((units, char) => units + (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char) ? 1 : char === ' ' ? 0.32 : 0.56), 0);
}

function escapeSvgText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
