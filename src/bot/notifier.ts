import { InputFile } from 'grammy';
import { errInfo, log } from '../log.js';
import type { UserRow } from '../storage/repo.js';
import type { Msg } from './format.js';

type Opts = { parse_mode: 'HTML'; disable_notification: boolean };

export interface SendApi {
  sendMessage(chatId: number, text: string, opts: Opts): Promise<unknown>;
  sendPhoto(chatId: number, photo: InputFile | string, opts: Opts & { caption: string }): Promise<{ photo?: { file_id: string }[] }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorCode(e: unknown): number | undefined {
  const any = e as { error_code?: number };
  return typeof any?.error_code === 'number' ? any.error_code : undefined;
}

function retryAfterSec(e: unknown): number {
  const any = e as { parameters?: { retry_after?: number } };
  return any?.parameters?.retry_after ?? 5;
}

export async function broadcast(
  api: SendApi,
  users: UserRow[],
  msg: Msg,
  onBlocked: (tgId: number) => void,
  quietHour = false,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let fileId: string | null = null; // upload once, reuse for everyone else
  let photoOk = !!msg.photo;
  for (const u of users) {
    const opts: Opts = { parse_mode: 'HTML', disable_notification: msg.silent || u.muted || (u.nightQuiet && quietHour) };
    const sendPhoto = async () => {
      const res = await api.sendPhoto(u.tgId, fileId ?? new InputFile(msg.photo!, 'deye.png'), { ...opts, caption: msg.text });
      fileId ??= res.photo?.at(-1)?.file_id ?? null;
    };
    const send = async () => {
      if (!photoOk) return void (await api.sendMessage(u.tgId, msg.text, opts));
      try {
        await sendPhoto();
      } catch (e) {
        const code = errorCode(e);
        if (code === 403 || code === 429) throw e;
        log.warn('photo send failed, falling back to text', errInfo(e));
        photoOk = false;
        await api.sendMessage(u.tgId, msg.text, opts);
      }
    };
    try {
      try {
        await send();
      } catch (e) {
        if (errorCode(e) !== 429) throw e;
        await sleep(retryAfterSec(e) * 1000);
        await send();
      }
      sent++;
    } catch (e) {
      failed++;
      if (errorCode(e) === 403) onBlocked(u.tgId);
      else log.warn('send failed', { tgId: u.tgId, ...errInfo(e) });
    }
  }
  return { sent, failed };
}
