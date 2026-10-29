import { describe, expect, it } from 'vitest';
import { CONNECTORS, getConnector, type DropEvent } from '../src/integrations';

const event: DropEvent = {
  id: 'evt1',
  type: 'release.published',
  at: Date.UTC(2026, 9, 29),
  actor: 'dev@example.com',
  project: { slug: 'my-pack', name: 'My Pack' },
  title: 'My Pack — v1.2.0',
  body: 'Fixed the garage MLO',
  url: 'https://panel.example.com/p/my-pack/r/1.2.0',
  data: { version: '1.2.0' },
};

const sample: Record<string, Record<string, string>> = {
  discord: { url: 'https://discord.com/api/webhooks/1/abc' },
  slack: { url: 'https://hooks.slack.com/services/T/B/x' },
  teams: { url: 'https://prod.westus.logic.azure.com/workflows/x' },
  googlechat: { url: 'https://chat.googleapis.com/v1/spaces/x/messages?key=k' },
  telegram: { botToken: '123456:ABC-def', chatId: '-100123' },
  matrix: { homeserver: 'https://matrix.example.com', roomId: '!r:example.com', accessToken: 't' },
  mattermost: { url: 'https://chat.example.com/hooks/x' },
  ntfy: { topic: 'my-secret-topic' },
  webhook: { url: 'https://example.com/hook', secret: 's3cret' },
};

describe('connectors', () => {
  it('has a valid sample config and builds a request for every connector', async () => {
    for (const k of CONNECTORS) {
      const config = sample[k.type];
      expect(config, k.type).toBeDefined();
      expect(k.check?.(config!) ?? null, k.type).toBeNull();
      const req = await k.build(config!, event);
      expect(req.url.startsWith('https://'), k.type).toBe(true);
      expect(req.body.length, k.type).toBeGreaterThan(0);
    }
  });

  it('rejects missing or non-https URLs', () => {
    expect(getConnector('slack')!.check!({ url: '' })).toMatch(/required/);
    expect(getConnector('slack')!.check!({ url: 'http://hooks.slack.com/x' })).toMatch(/https/);
    expect(getConnector('discord')!.check!({ url: 'https://example.com/hook' })).toMatch(/Discord/);
    expect(getConnector('telegram')!.check!({ botToken: 'nope', chatId: '1' })).toMatch(/token/);
  });

  it('puts the release into the Discord embed', async () => {
    const req = await getConnector('discord')!.build(sample.discord!, event);
    const embed = JSON.parse(req.body).embeds[0];
    expect(embed.title).toBe('My Pack — v1.2.0');
    expect(embed.description).toBe('Fixed the garage MLO');
    expect(embed.footer.text).toBe('dropyard · my-pack');
  });

  it('signs webhook bodies with HMAC-SHA256 over "<timestamp>.<body>"', async () => {
    const req = await getConnector('webhook')!.build(sample.webhook!, event);
    const ts = req.headers!['x-dropyard-timestamp']!;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${req.body}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(req.headers!['x-dropyard-signature']).toBe(`sha256=${hex}`);
    expect(req.headers!['x-dropyard-delivery']).toBe('evt1');
  });

  it('leaves the webhook unsigned without a secret', async () => {
    const req = await getConnector('webhook')!.build({ url: 'https://example.com/hook' }, event);
    expect(req.headers!['x-dropyard-signature']).toBeUndefined();
  });
});
