import { clip, httpsUrl, json, jsonHeaders, type Connector, type DropEvent } from './types';

export function slackPayload(e: DropEvent) {
  const head = e.url ? `*<${e.url}|${e.title}>*` : `*${e.title}*`;
  return { text: [head, clip(e.body, 500)].filter(Boolean).join('\n') };
}

export const slack: Connector = {
  type: 'slack',
  label: 'Slack',
  description: 'Post to a Slack channel through an incoming webhook.',
  fields: [
    {
      key: 'url',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      secret: true,
      placeholder: 'https://hooks.slack.com/services/…',
    },
  ],
  check: (c) => httpsUrl(c.url, 'Webhook URL'),
  build: (c, e) => ({ url: c.url!, headers: jsonHeaders, body: json(slackPayload(e)) }),
};

export const mattermost: Connector = {
  type: 'mattermost',
  label: 'Mattermost',
  description: 'Post to a Mattermost channel through an incoming webhook.',
  fields: [
    { key: 'url', label: 'Webhook URL', type: 'url', required: true, secret: true, placeholder: 'https://chat.example.com/hooks/…' },
  ],
  check: (c) => httpsUrl(c.url, 'Webhook URL'),
  build: (c, e) => ({ url: c.url!, headers: jsonHeaders, body: json(slackPayload(e)) }),
};
