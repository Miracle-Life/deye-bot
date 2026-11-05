import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONTS = ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) => `${FONT_DIR}Inter-${w}.ttf`);
const GC_DELAY_MS = 2_000;

// Each render holds ~6–11 MB of native (Rust) memory that V8 doesn't see, so it isn't
// collected for a long time; RSS can reach a GB on the NAS. Collect shortly after a burst
// of renders (needs `node --expose-gc`; a no-op without it).
let gcTimer: NodeJS.Timeout | null = null;
function scheduleGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc || gcTimer) return;
  gcTimer = setTimeout(() => {
    gcTimer = null;
    gc();
  }, GC_DELAY_MS);
  gcTimer.unref();
}

/** Renders at 2× for crisp text on phones. */
export function toPng(svg: string, width: number): Buffer {
  const r = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: width * 2 },
  });
  const png = r.render().asPng();
  scheduleGc();
  return png;
}
