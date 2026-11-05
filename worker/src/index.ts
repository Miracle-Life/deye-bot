// Deye Home watchdog: the bot on the NAS checks in; if it goes quiet, tell users via the same bot.
import { authorized, downAfterMs, onBeat, onCron, parseBeat, silentFor, type Beat, type State, type Text } from './logic.js';

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  WATCH: KV;
  TELEGRAM_TOKEN: string;
  BEAT_SECRET: string;
  DOWN_AFTER_MIN?: string;
}

const readJson = async <T>(kv: KV, key: string): Promise<T | null> => {
  const v = await kv.get(key);
  return v ? (JSON.parse(v) as T) : null;
};

async function tell(env: Env, beat: Beat, text: Text, nowMs: number): Promise<void> {
  for (const c of beat.chats) {
    // One failing chat (network error) must not stop the others.
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.id, text: text(c.lang), parse_mode: 'HTML', disable_notification: silentFor(c, beat, nowMs) }),
      });
      if (!res.ok) console.log('telegram send failed', res.status);
    } catch (e) {
      console.log('telegram send error', String(e));
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/beat') return new Response('not found', { status: 404 });
    if (!authorized(req.headers.get('authorization'), env.BEAT_SECRET)) return new Response('forbidden', { status: 403 });
    const beat = parseBeat(await req.json().catch(() => null));
    if (!beat) return new Response('bad beat', { status: 400 });
    const now = Date.now();
    beat.ts = now; // trust our own clock, not the NAS's
    const state = (await readJson<State>(env.WATCH, 'state')) ?? { downSince: null };
    const r = onBeat(state, now, beat.tz);
    await env.WATCH.put('beat', JSON.stringify(beat));
    if (r.msg) {
      await env.WATCH.put('state', JSON.stringify(r.state));
      await tell(env, beat, r.msg, now);
    }
    return new Response('ok');
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const beat = parseBeat(await readJson<unknown>(env.WATCH, 'beat'));
    const state = (await readJson<State>(env.WATCH, 'state')) ?? { downSince: null };
    const now = Date.now();
    const r = onCron(beat, state, now, downAfterMs(env.DOWN_AFTER_MIN));
    if (!r.msg || !beat) return;
    await env.WATCH.put('state', JSON.stringify(r.state));
    await tell(env, beat, r.msg, now);
  },
};
