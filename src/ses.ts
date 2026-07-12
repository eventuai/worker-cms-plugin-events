// ── AWS SES v2 email adapter ───────────────────────────────────────────────────
// Sends through the SES v2 HTTP API (`SendEmail`) with a hand-rolled SigV4
// signature over WebCrypto — no AWS SDK, so nothing Node-shaped enters the
// Worker bundle. This exists because the Cloudflare Email Service binding can
// only send from domains whose DNS is hosted on Cloudflare; SES has no such
// constraint and is what the legacy eventuai admin already sent through, so
// its verified identities carry over unchanged.
//
// Configuration is plain env vars (see SesEnv), which means multi-tenant
// installs can point tenants at different SES accounts/regions via the
// TENANTS record's `vars` — tenantClientEnv() spreads them over the env
// before the queue consumer delivers.

import type { OutboundEmail } from './edm';

export interface SesEnv {
  /** SES region, e.g. "ap-southeast-1". With both keys set, delivery routes to SES. */
  AWS_SES_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** Only for temporary (STS) credentials; signed in as x-amz-security-token. */
  AWS_SESSION_TOKEN?: string;
  /** Optional SES configuration set applied to every send (bounce/open tracking). */
  AWS_SES_CONFIGURATION_SET?: string;
  /** API endpoint override (tests); defaults to https://email.<region>.amazonaws.com. */
  AWS_SES_ENDPOINT?: string;
}

/** True when region + key pair are all present — deliverQueuedEmail then prefers SES. */
export function sesConfigured(env: SesEnv): boolean {
  return Boolean(env.AWS_SES_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/** Sends one email via SES v2 SendEmail; throws with SES's message on any non-2xx. */
export async function sendViaSes(env: SesEnv, email: OutboundEmail): Promise<void> {
  const region = env.AWS_SES_REGION ?? '';
  const url = new URL('/v2/email/outbound-emails', env.AWS_SES_ENDPOINT || `https://email.${region}.amazonaws.com`);
  const body = JSON.stringify({
    FromEmailAddress: email.from,
    Destination: {
      ToAddresses: [email.to],
      ...(email.bcc?.length ? { BccAddresses: email.bcc } : {}),
    },
    ...(email.replyTo ? { ReplyToAddresses: [email.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: email.html, Charset: 'UTF-8' },
          Text: { Data: email.text, Charset: 'UTF-8' },
        },
      },
    },
    ...(env.AWS_SES_CONFIGURATION_SET ? { ConfigurationSetName: env.AWS_SES_CONFIGURATION_SET } : {}),
  });

  const headers = await signedHeaders(env, region, url, body);
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    const detail = await response.json().then((json) => (json as { message?: string }).message, () => '');
    throw new Error(`SES send failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
}

// ── SigV4 (https://docs.aws.amazon.com/IAM/latest/UserGuide/signing-elements.html)

const SERVICE = 'ses';
const encoder = new TextEncoder();

async function signedHeaders(env: SesEnv, region: string, url: URL, body: string): Promise<Record<string, string>> {
  // 20260712T030405Z — SigV4's ISO-8601 "basic" timestamp.
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  // Headers participating in the signature, already in the sorted order SigV4
  // requires. `host` is signed but never set on the request — fetch adds it.
  const headers: Array<[name: string, value: string]> = [
    ['content-type', 'application/json'],
    ['host', url.host],
    ['x-amz-date', amzDate],
    ...(env.AWS_SESSION_TOKEN ? [['x-amz-security-token', env.AWS_SESSION_TOKEN] as [string, string]] : []),
  ];
  const signedHeaderNames = headers.map(([name]) => name).join(';');

  const canonicalRequest = [
    'POST',
    url.pathname,
    '', // canonical query string (SendEmail has none)
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaderNames,
    await sha256Hex(body),
  ].join('\n');

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let key: BufferSource = encoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`);
  for (const part of [dateStamp, region, SERVICE, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  return {
    ...Object.fromEntries(headers.filter(([name]) => name !== 'host')),
    authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  };
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
