import { clip, httpsUrl, json, jsonHeaders, type Connector } from './types';

export const teams: Connector = {
  type: 'teams',
  label: 'Microsoft Teams',
  description: 'Post to a Teams channel through a Workflows webhook.',
  fields: [
    {
      key: 'url',
      label: 'Workflow webhook URL',
      type: 'url',
      required: true,
      secret: true,
      help: 'Channel → Workflows → "Post to a channel when a webhook request is received".',
    },
  ],
  check: (c) => httpsUrl(c.url, 'Workflow webhook URL'),
  build: (c, e) => ({
    url: c.url!,
    headers: jsonHeaders,
    body: json({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: e.title, weight: 'Bolder', size: 'Medium', wrap: true },
              ...(e.body ? [{ type: 'TextBlock', text: clip(e.body, 500), wrap: true }] : []),
            ],
            actions: e.url ? [{ type: 'Action.OpenUrl', title: 'Open in dropyard', url: e.url }] : [],
          },
        },
      ],
    }),
  }),
};
