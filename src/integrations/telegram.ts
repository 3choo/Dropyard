import { json, jsonHeaders, plainText, type Connector } from './types';

export const telegram: Connector = {
  type: 'telegram',
  label: 'Telegram',
  description: 'Send a message to a Telegram chat or channel with a bot.',
  fields: [
    { key: 'botToken', label: 'Bot token', type: 'secret', required: true, secret: true, help: 'Create a bot with @BotFather.' },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890 or @channelname' },
  ],
  check: (c) => {
    if (!c.botToken) return 'Bot token is required';
    if (!/^\d+:[\w-]+$/.test(c.botToken)) return 'That does not look like a Telegram bot token';
    if (!c.chatId) return 'Chat ID is required';
    return null;
  },
  build: (c, e) => ({
    url: `https://api.telegram.org/bot${c.botToken}/sendMessage`,
    headers: jsonHeaders,
    body: json({ chat_id: c.chatId, text: plainText(e), disable_web_page_preview: true }),
  }),
};
