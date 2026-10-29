import { httpsUrl, json, type Connector } from './types';

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const webhook: Connector = {
  type: 'webhook',
  label: 'Webhook',
  description: 'POST every event as signed JSON to any URL (n8n, Zapier, your own server).',
  fields: [
    { key: 'url', label: 'Payload URL', type: 'url', required: true, secret: true },
    { key: 'secret', label: 'Signing secret', type: 'secret', secret: true, help: 'Optional. Used to sign each request so the receiver can verify it.' },
  ],
  check: (c) => httpsUrl(c.url, 'Payload URL'),
  build: async (c, e) => {
    const body = json(e);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'dropyard-webhook',
      'x-dropyard-event': e.type,
      'x-dropyard-delivery': e.id,
    };
    if (c.secret) {
      const ts = String(Date.now());
      headers['x-dropyard-timestamp'] = ts;
      headers['x-dropyard-signature'] = `sha256=${await hmacHex(c.secret, `${ts}.${body}`)}`;
    }
    return { url: c.url!, headers, body };
  },
};
