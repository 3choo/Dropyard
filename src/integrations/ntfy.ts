import { httpsUrl, type Connector } from './types';

export const ntfy: Connector = {
  type: 'ntfy',
  label: 'ntfy',
  description: 'Push notification to a ntfy topic (ntfy.sh or self-hosted).',
  fields: [
    { key: 'server', label: 'Server', type: 'url', placeholder: 'https://ntfy.sh', help: 'Leave empty for ntfy.sh.' },
    { key: 'topic', label: 'Topic', type: 'text', required: true, secret: true, help: 'Anyone who knows the topic can read it, so make it hard to guess.' },
    { key: 'token', label: 'Access token', type: 'secret', secret: true, help: 'Only for protected topics.' },
  ],
  check: (c) => {
    if (c.server) {
      const bad = httpsUrl(c.server, 'Server');
      if (bad) return bad;
    }
    return c.topic ? (/^[\w-]{1,64}$/.test(c.topic) ? null : 'Topic may only use letters, numbers, - and _') : 'Topic is required';
  },
  build: (c, e) => ({
    url: `${(c.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${c.topic}`,
    headers: {
      title: e.title.replace(/[^\x20-\x7e]/g, '?'),
      ...(e.url ? { click: e.url } : {}),
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
    },
    body: e.body || e.title,
  }),
};
