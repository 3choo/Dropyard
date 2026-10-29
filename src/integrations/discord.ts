import { clip, httpsUrl, json, jsonHeaders, type Connector } from './types';

export const discord: Connector = {
  type: 'discord',
  label: 'Discord',
  description: 'Post to a Discord channel through a webhook.',
  fields: [
    {
      key: 'url',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      secret: true,
      placeholder: 'https://discord.com/api/webhooks/…',
      help: 'Channel settings → Integrations → Webhooks.',
    },
  ],
  check: (c) =>
    httpsUrl(c.url, 'Webhook URL') ??
    (/^https:\/\/(?:[a-z]+\.)?(?:discord|discordapp)\.com\/api\/webhooks\//.test(c.url!)
      ? null
      : 'That does not look like a Discord webhook URL'),
  build: (c, e) => ({
    url: c.url!,
    headers: jsonHeaders,
    body: json({
      embeds: [
        {
          title: clip(e.title, 256),
          url: e.url || undefined,
          description: clip(e.body, 500) || undefined,
          color: 0xc9f24f,
          footer: { text: e.project ? `dropyard · ${e.project.slug}` : 'dropyard' },
          timestamp: new Date(e.at).toISOString(),
        },
      ],
    }),
  }),
};
