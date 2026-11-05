const SECRET_KEY = /secret|password|token|authorization|email/i;

/** Tokens can hide inside error texts (URLs, headers). */
const scrub = (s: string) => s.replace(/\bbot\d+:[\w-]+/g, 'bot***').replace(/Bearer\s+\S+/g, 'Bearer ***');

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '***' : redact(v)]),
    );
  }
  return value;
}

let errorSink: ((msg: string, extra?: object) => void) | null = null;

/** Every log.error is also handed to the sink (admin notifications). */
export function setErrorSink(fn: typeof errorSink): void {
  errorSink = fn;
}

function write(level: string, msg: string, extra?: object): void {
  const safe = extra ? (redact(extra) as object) : undefined;
  msg = scrub(msg);
  const line = { t: new Date().toISOString(), level, msg, ...(safe ?? {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
  if (level === 'error') {
    try {
      errorSink?.(msg, safe);
    } catch {
      // the sink must never break logging
    }
  }
}

export const log = {
  info: (msg: string, extra?: object) => write('info', msg, extra),
  warn: (msg: string, extra?: object) => write('warn', msg, extra),
  error: (msg: string, extra?: object) => write('error', msg, extra),
};

export function errInfo(e: unknown): { error: string } {
  if (!(e instanceof Error)) return { error: String(e) };
  // fetch() hides the real reason (DNS, TLS, refused) in `cause`.
  const c = e.cause as { code?: string; message?: string } | undefined;
  const why = c ? [c.code, c.message].filter(Boolean).join(' ') : '';
  return { error: why ? `${e.message}: ${why}` : e.message };
}
