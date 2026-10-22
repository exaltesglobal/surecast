// Telegram channels and groups, posted by a bot that the person adds as an admin.
import { blobOf, http } from './http.js';
import { codepoints } from './text.js';
import { PublishError, type Adapter, type ChannelCtx } from './types.js';

type Creds = { botToken: string; chatId: string };

async function tg<T>(botToken: string, method: string, body?: FormData | Record<string, unknown>): Promise<T> {
  try {
    const { data } = await http<{ ok: boolean; result: T }>('Telegram', `https://api.telegram.org/bot${botToken}/${method}`, body instanceof FormData ? { method: 'POST', body } : body ? { json: body } : {});
    return data.result;
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    if (e.httpStatus === 401 || e.httpStatus === 404) e.hint = 'The bot token is no longer valid. Create a new token with @BotFather and reconnect this channel.';
    if (e.httpStatus === 401 || e.httpStatus === 404) e.kind = 'auth';
    if (e.httpStatus === 403) {
      e.kind = 'auth';
      e.hint = 'The bot was removed from the channel or lost its admin rights. Add it back as an admin with permission to post.';
    }
    if (/chat not found/i.test(e.message)) {
      e.kind = 'auth';
      e.hint = 'Telegram cannot find this channel. Check the channel username and that the bot is an admin there.';
    }
    throw e;
  }
}

const messageUrl = (ch: ChannelCtx, messageId: number) => {
  const handle = ch.handle.replace(/^@/, '');
  if (handle && !/^-?\d+$/.test(handle)) return `https://t.me/${handle}/${messageId}`;
  const id = ch.externalId.replace(/^-100/, '');
  return `https://t.me/c/${id}/${messageId}`;
};

export const telegram: Adapter = {
  platform: 'telegram',
  label: 'Telegram',
  // Text messages allow 4096 characters, but a caption on a photo only 1024.
  limits: { maxChars: 4096, maxImages: 10, maxImageBytes: 10_000_000, imageTypes: ['image/jpeg', 'image/png', 'image/webp'] },
  available: () => true,
  count: codepoints,
  connect: {
    kind: 'fields',
    help: 'Create a bot with @BotFather, add it to your channel as an admin who can post messages, then paste its token and the channel username here.',
    fields: [
      { name: 'botToken', label: 'Bot token', type: 'password', placeholder: '123456:ABC-DEF...', required: true },
      { name: 'chatId', label: 'Channel username or chat ID', type: 'text', placeholder: '@yourchannel', required: true },
    ],
    async submit(v) {
      const botToken = v.botToken.trim();
      let chatId = v.chatId.trim();
      if (!/^-?\d+$/.test(chatId) && !chatId.startsWith('@')) chatId = `@${chatId.replace(/^https?:\/\/t\.me\//, '')}`;
      await tg(botToken, 'getMe');
      const chat = await tg<{ id: number; title?: string; username?: string }>(botToken, 'getChat', { chat_id: chatId });
      return {
        name: chat.title ?? chat.username ?? chatId,
        handle: chat.username ? `@${chat.username}` : String(chat.id),
        externalId: String(chat.id),
        avatarUrl: null,
        credentials: { botToken, chatId: String(chat.id) } satisfies Creds,
        tokenExpiresAt: null,
      };
    },
  },
  async check(ch) {
    const c = ch.credentials as Creds;
    const chat = await tg<{ title?: string }>(c.botToken, 'getChat', { chat_id: c.chatId });
    const me = await tg<{ id: number }>(c.botToken, 'getMe');
    const member = await tg<{ status: string; can_post_messages?: boolean }>(c.botToken, 'getChatMember', { chat_id: c.chatId, user_id: me.id });
    if (member.status !== 'administrator' && member.status !== 'creator')
      throw new PublishError('auth', 'not_admin', 'The bot is not an admin of this channel', 'Make the bot an admin of the channel with permission to post messages.');
    return { name: chat.title };
  },
  async publish(ch, input) {
    const c = ch.credentials as Creds;
    if (!input.media.length) {
      const msg = await tg<{ message_id: number }>(c.botToken, 'sendMessage', { chat_id: c.chatId, text: input.text });
      return { remoteId: String(msg.message_id), url: messageUrl(ch, msg.message_id) };
    }
    if (codepoints(input.text) > 1024)
      throw new PublishError('permanent', 'caption_too_long', 'Telegram captions on images are limited to 1024 characters', 'Shorten the text for Telegram, or remove the images.');
    if (input.media.length === 1) {
      const form = new FormData();
      form.append('chat_id', c.chatId);
      form.append('caption', input.text);
      form.append('photo', await blobOf(input.media[0]), input.media[0].filename);
      const msg = await tg<{ message_id: number }>(c.botToken, 'sendPhoto', form);
      return { remoteId: String(msg.message_id), url: messageUrl(ch, msg.message_id) };
    }
    const form = new FormData();
    form.append('chat_id', c.chatId);
    const group = [];
    for (const [i, m] of input.media.entries()) {
      form.append(`p${i}`, await blobOf(m), m.filename);
      group.push({ type: 'photo', media: `attach://p${i}`, ...(i === 0 ? { caption: input.text } : {}) });
    }
    form.append('media', JSON.stringify(group));
    const msgs = await tg<{ message_id: number }[]>(c.botToken, 'sendMediaGroup', form);
    return { remoteId: String(msgs[0].message_id), url: messageUrl(ch, msgs[0].message_id) };
  },
};
