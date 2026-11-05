// One-off API discovery: prints raw Deye OpenAPI responses (secrets redacted) to find field names.
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { sha256Hex } from '../src/deye/official.js';
import { redact } from '../src/log.js';

process.loadEnvFile('.env');
// Telegram keys aren't needed for discovery.
const cfg = loadConfig({
  ...process.env,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN?.trim() || '-',
  ADMIN_TELEGRAM_ID: process.env.ADMIN_TELEGRAM_ID?.trim() || '0',
});
const out: Record<string, unknown> = {};

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(cfg.deyeBaseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({ nonJson: true }));
  out[path] = { status: res.status, body: redact(json) };
  console.log(`\n=== ${path} → HTTP ${res.status}`);
  console.log(JSON.stringify(redact(json), null, 2).slice(0, 6000));
  return json;
}

const tokenRes = await post(`/account/token?appId=${encodeURIComponent(cfg.deyeAppId)}`, {
  appSecret: cfg.deyeAppSecret,
  email: cfg.deyeEmail,
  password: sha256Hex(cfg.deyePassword),
});
const token: string | undefined = tokenRes?.accessToken ?? tokenRes?.data?.accessToken;
if (!token) {
  console.error('\nNo accessToken in response — check AppID/AppSecret/email/password.');
  process.exit(1);
}

const stations = await post('/station/list', { page: 1, size: 10 }, token);
const stationList: any[] = stations?.stationList ?? stations?.data?.stationList ?? [];
const stationId = cfg.deyeStationId ?? stationList[0]?.id;
if (stationId) {
  await post('/station/latest', { stationId: Number(stationId) }, token);
  const dev = await post('/station/device', { page: 1, size: 10, stationIds: [Number(stationId)] }, token);
  const devices: any[] = dev?.deviceListItems ?? dev?.data?.deviceListItems ?? [];
  const inverter = cfg.deyeDeviceSn ?? devices.find((d) => /INVERTER/i.test(String(d.deviceType)))?.deviceSn ?? devices[0]?.deviceSn;
  if (inverter) {
    await post('/device/latest', { deviceList: [String(inverter)] }, token);
    await post('/device/measurePoints', { deviceSn: String(inverter) }, token);
    const today = new Date().toISOString().slice(0, 10);
    await post(
      '/device/history',
      {
        deviceSn: String(inverter),
        granularity: 1,
        startAt: today,
        endAt: today,
        measurePoints: ['SOC', 'BatteryPower', 'GridVoltageL1', 'GridVoltageL2', 'GridVoltageL3'],
      },
      token,
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  await post('/station/history', { stationId: Number(stationId), granularity: 1, startAt: today }, token);
}

mkdirSync('tmp', { recursive: true });
writeFileSync('tmp/deye-raw.json', JSON.stringify(out, null, 2));
console.log('\nSaved redacted responses to tmp/deye-raw.json');
