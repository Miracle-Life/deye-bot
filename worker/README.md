# Deye Home watchdog (Cloudflare Worker)

The bot on the NAS checks in every 3 minutes. If check-ins stop for 10 minutes (no internet at home,
router or NAS off, bot down), the worker messages users who enabled `🛰 «Дом не на связи»` in `/settings`,
through the same Telegram bot. When check-ins resume it says the home is back online.
Free plan is enough (~480 KV writes/day of 1000).

## Deploy (once)

```bash
cd worker
npm install
npx wrangler login                          # opens the browser
npx wrangler kv namespace create WATCH      # paste the printed id into wrangler.toml
npx wrangler secret put TELEGRAM_TOKEN      # same token as the bot's .env
openssl rand -hex 24                        # a new random secret for check-ins
npx wrangler secret put BEAT_SECRET         # paste that secret
npx wrangler deploy                         # prints https://deye-home-watchdog.<you>.workers.dev
```

Then in the bot's `.env`:

```
WATCHDOG_URL=https://deye-home-watchdog.<you>.workers.dev
WATCHDOG_SECRET=<the same secret>
```

and restart the bot. Logs: `npx wrangler tail`.

Note: any stop of the bot longer than 10 minutes (including Ctrl+C on a dev machine) is reported — that's the point.
