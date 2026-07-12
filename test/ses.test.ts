import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverQueuedEmail, type OutboundEmail } from '../src/edm';
import { sendViaSes, sesConfigured } from '../src/ses';

const SES_ENV = {
  AWS_SES_REGION: 'ap-southeast-1',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret-key',
};

function email(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    from: 'events@example.com',
    to: 'guest@example.com',
    subject: 'Hi',
    html: '<p>Join us</p>',
    text: 'Join us',
    ...overrides,
  };
}

/** Stubs global fetch with an SES endpoint that records the one request. */
function stubSesFetch(status = 200, body: unknown = {}) {
  const captured: { url?: string; method?: string; headers?: Headers; body?: string } = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.url = String(input instanceof Request ? input.url : input);
    captured.method = init?.method;
    captured.headers = new Headers(init?.headers);
    captured.body = String(init?.body);
    return new Response(JSON.stringify(body), { status });
  }));
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SES adapter', () => {
  it('is configured only when region and both keys are present', () => {
    expect(sesConfigured(SES_ENV)).toBe(true);
    expect(sesConfigured({})).toBe(false);
    expect(sesConfigured({ ...SES_ENV, AWS_SECRET_ACCESS_KEY: undefined })).toBe(false);
    expect(sesConfigured({ ...SES_ENV, AWS_SES_REGION: '' })).toBe(false);
  });

  it('posts a SigV4-signed SendEmail request to the regional endpoint', async () => {
    const captured = stubSesFetch();
    await sendViaSes({ ...SES_ENV, AWS_SES_CONFIGURATION_SET: 'default' }, email({
      replyTo: 'rsvp@example.com',
      bcc: ['archive@example.com', 'log@example.com'],
    }));

    expect(captured.url).toBe('https://email.ap-southeast-1.amazonaws.com/v2/email/outbound-emails');
    expect(captured.method).toBe('POST');
    expect(captured.headers?.get('content-type')).toBe('application/json');
    expect(captured.headers?.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    const date = captured.headers?.get('x-amz-date')?.slice(0, 8);
    expect(captured.headers?.get('authorization')).toMatch(new RegExp(
      `^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/${date}/ap-southeast-1/ses/aws4_request, `
      + 'SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$',
    ));

    expect(JSON.parse(captured.body ?? '')).toEqual({
      FromEmailAddress: 'events@example.com',
      Destination: {
        ToAddresses: ['guest@example.com'],
        BccAddresses: ['archive@example.com', 'log@example.com'],
      },
      ReplyToAddresses: ['rsvp@example.com'],
      Content: {
        Simple: {
          Subject: { Data: 'Hi', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Join us</p>', Charset: 'UTF-8' },
            Text: { Data: 'Join us', Charset: 'UTF-8' },
          },
        },
      },
      ConfigurationSetName: 'default',
    });
  });

  it('omits Bcc, ReplyTo, and ConfigurationSetName when unset', async () => {
    const captured = stubSesFetch();
    await sendViaSes(SES_ENV, email({ bcc: [] }));
    const body = JSON.parse(captured.body ?? '') as Record<string, unknown>;
    expect(body).not.toHaveProperty('ReplyToAddresses');
    expect(body).not.toHaveProperty('ConfigurationSetName');
    expect(body.Destination).toEqual({ ToAddresses: ['guest@example.com'] });
  });

  it('signs the session token in for temporary credentials', async () => {
    const captured = stubSesFetch();
    await sendViaSes({ ...SES_ENV, AWS_SESSION_TOKEN: 'sts-token' }, email());
    expect(captured.headers?.get('x-amz-security-token')).toBe('sts-token');
    expect(captured.headers?.get('authorization'))
      .toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,');
  });

  it('honors an endpoint override', async () => {
    const captured = stubSesFetch();
    await sendViaSes({ ...SES_ENV, AWS_SES_ENDPOINT: 'https://ses.local.test' }, email());
    expect(captured.url).toBe('https://ses.local.test/v2/email/outbound-emails');
  });

  it("surfaces SES's error message on a non-2xx response", async () => {
    stubSesFetch(400, { message: 'Email address is not verified.' });
    await expect(sendViaSes(SES_ENV, email()))
      .rejects.toThrow('SES send failed (400): Email address is not verified.');
  });
});

describe('deliverQueuedEmail backend selection', () => {
  const delivery = { ...email({ from: '' }), edmId: 12 };

  it('prefers SES over the EMAIL binding and falls back to EMAIL_FROM', async () => {
    const captured = stubSesFetch();
    const EMAIL = { send: vi.fn() };
    await deliverQueuedEmail({ ...SES_ENV, EMAIL, EMAIL_FROM: 'noreply@example.com' }, delivery);
    expect(EMAIL.send).not.toHaveBeenCalled();
    expect((JSON.parse(captured.body ?? '') as { FromEmailAddress: string }).FromEmailAddress)
      .toBe('noreply@example.com');
  });

  it('uses the EMAIL binding when SES is not configured', async () => {
    const EMAIL = { send: vi.fn() };
    await deliverQueuedEmail({ EMAIL, EMAIL_FROM: 'noreply@example.com' }, delivery);
    expect(EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'noreply@example.com', to: 'guest@example.com' }));
  });

  it('throws when no backend is configured', async () => {
    await expect(deliverQueuedEmail({ EMAIL_FROM: 'noreply@example.com' }, delivery))
      .rejects.toThrow('Configure the EMAIL binding or the AWS_SES_* vars');
  });

  it('throws when no sender can be resolved', async () => {
    await expect(deliverQueuedEmail({ ...SES_ENV }, delivery))
      .rejects.toThrow('EMAIL_FROM (or the EDM sender) must be configured');
  });
});
