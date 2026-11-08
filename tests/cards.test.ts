import { describe, expect, it } from 'vitest';
import { fitFont } from '../src/render/cards.js';

describe('fitFont', () => {
  it('keeps the base size when the text fits', () => {
    expect(fitFont('77%', 160, 26)).toBe(26);
  });

  it('shrinks long values so they stay inside their column', () => {
    const size = fitFont('180.0 кВт·год', 160, 26);
    expect(size).toBeLessThan(26);
    expect('180.0 кВт·год'.length * size * 0.6).toBeLessThanOrEqual(160);
  });
});

describe('ringColor', () => {
  it('seven equal 15 % steps from deep red to emerald', async () => {
    const { ringColor } = await import('../src/render/cards.js');
    expect([0, 14, 15, 29, 30, 44, 45, 59, 60, 74, 75, 89, 90, 100].map(ringColor)).toEqual([
      '#b91c1c', '#b91c1c', '#ef4444', '#ef4444', '#f97316', '#f97316', '#facc15', '#facc15', '#a3e635', '#a3e635', '#4ade80', '#4ade80', '#10b981', '#10b981',
    ]);
  });
});

describe('load bar', () => {
  it('thick contrasting bar, rounded zone strip, limit on its own line', async () => {
    const { svgPanel } = await import('../src/render/cards.js');
    const svg = svgPanel({
      status: { kind: 'on', label: 'on' }, time: null, stale: null, soc: 90, socKwh: null, flow: null, eta: null, schedule: null, tiles: [], caption: '',
      load: { label: 'З мережі', value: '5.53', max: '10 кВт', zone: 'yellow', scale: { yellow: 0.5, orange: 0.65, red: 0.8 }, homeFrac: 0.136, batteryFrac: 0.417,
        legend: { home: { label: 'Будинок', kw: '1.36' }, battery: { label: 'Батареї', kw: '4.17' }, limit: 'ліміт заряду з мережі 80 А ≈ 4.35 кВт' } },
    });
    expect(svg).toContain('#38bdf8'); // home
    expect(svg).toContain('#e879f9'); // batteries
    expect(svg).toMatch(/<clipPath id="loadBar"><rect [^>]*height="18" rx="9"/);
    expect(svg).toMatch(/<clipPath id="zoneStrip"><rect [^>]*rx="2"/);
    expect(svg).toMatch(/fill="#38bdf8"[^>]*>1\.36<\/tspan>/);
  });
});
