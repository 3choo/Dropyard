import { httpsUrl, json, jsonHeaders, plainText, type Connector } from './types';

export const matrix: Connector = {
  type: 'matrix',
  label: 'Matrix',
  description: 'Send a message to a Matrix room with an access token.',
  fields: [
    { key: 'homeserver', label: 'Homeserver URL', type: 'url', required: true, placeholder: 'https://matrix.example.com' },
    { key: 'roomId', label: 'Room ID', type: 'text', required: true, placeholder: '!abc123:example.com' },
    { key: 'accessToken', label: 'Access token', type: 'secret', required: true, secret: true },
  ],
  check: (c) => httpsUrl(c.homeserver, 'Homeserver URL') ?? (c.roomId ? (c.accessToken ? null : 'Access token is required') : 'Room ID is required'),
  build: (c, e) => ({
    url: `${c.homeserver!.replace(/\/+$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(c.roomId!)}/send/m.room.message/${encodeURIComponent(e.id)}`,
    method: 'PUT',
    headers: { ...jsonHeaders, authorization: `Bearer ${c.accessToken}` },
    body: json({ msgtype: 'm.text', body: plainText(e) }),
  }),
};
