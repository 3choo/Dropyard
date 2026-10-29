import { httpsUrl, json, jsonHeaders, plainText, type Connector } from './types';

export const googlechat: Connector = {
  type: 'googlechat',
  label: 'Google Chat',
  description: 'Post to a Google Chat space through a webhook.',
  fields: [
    { key: 'url', label: 'Webhook URL', type: 'url', required: true, secret: true, placeholder: 'https://chat.googleapis.com/v1/spaces/…' },
  ],
  check: (c) => httpsUrl(c.url, 'Webhook URL'),
  build: (c, e) => ({ url: c.url!, headers: jsonHeaders, body: json({ text: plainText(e) }) }),
};
