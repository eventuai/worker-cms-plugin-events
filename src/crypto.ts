import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signPayload(secret: string, data: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPayload(secret: string, data: string, hexSignature: string): Promise<boolean> {
  const bytes = hexSignature.match(/.{1,2}/g)?.map((hex) => parseInt(hex, 16));
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), new Uint8Array(bytes), new TextEncoder().encode(data));
}

/**
 * Compact Eventuai check-in payload.
 *
 * Legacy used radix 32 (not radix 36) and stored the guest id as a possibly
 * signed delta from the list id. `M` identifies the main attendee; plus guests
 * use their zero-based index. The signature input deliberately mirrors the
 * legacy `qrcode{listId}{guestId}{plusIndex?}` shape.
 */
export function compactCheckinCode(listId: number, guestId: number, plusGuestIndex?: number): string {
  if (!Number.isSafeInteger(listId) || listId <= 0 || !Number.isSafeInteger(guestId) || guestId <= 0) {
    throw new Error('invalid list/guest id for compact check-in code');
  }
  if (plusGuestIndex !== undefined && (!Number.isSafeInteger(plusGuestIndex) || plusGuestIndex < 0)) {
    throw new Error('invalid plus guest index for compact check-in code');
  }
  const marker = plusGuestIndex === undefined ? 'M' : String(plusGuestIndex);
  const signedValue = `qrcode${listId}${guestId}${plusGuestIndex ?? ''}`;
  const signature = bytesToHex(blake3(new TextEncoder().encode(signedValue))).slice(0, 6);
  return `EAI${listId.toString(32)}:${(guestId - listId).toString(32)}:${marker}:${signature}`;
}
