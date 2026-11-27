/**
 * The page shell every browser-facing page shares: landing, login flow, admin.
 *
 * Styles, script and fonts are served from /static by this same server, so
 * nothing is fetched from a CDN (a student's IP address never reaches Google).
 * Every value interpolated into a page that is not a constant goes through
 * `escapeHtml`: client names and display names are untrusted.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
export const STATIC_PREFIX = '/static';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Changes whenever the stylesheet or the script does, so browsers never keep a stale copy. */
const ASSET_VERSION = (() => {
  const hash = createHash('sha256');
  for (const file of ['app.css', 'app.js']) {
    try {
      hash.update(readFileSync(`${PUBLIC_DIR}${file}`));
    } catch {
      // Missing in some test setups: the pages still render.
    }
  }
  return hash.digest('hex').slice(0, 10);
})();

const BRAND_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true" class="brand-mark"><rect x="2" y="2" width="60" height="60" rx="15" fill="#2f5bff" stroke="#14193a" stroke-width="4"/><path d="M32 15 7 26l25 11 25-11z" fill="#fff" stroke="#14193a" stroke-width="2.5" stroke-linejoin="round"/><path d="M17 32v9c0 4 6.7 7.5 15 7.5S47 45 47 41v-9l-15 6.6z" fill="#fff" stroke="#14193a" stroke-width="2.5" stroke-linejoin="round"/><path d="M53 28v12" stroke="#ffd23f" stroke-width="4" stroke-linecap="round"/><circle cx="53" cy="43" r="4" fill="#ffd23f" stroke="#14193a" stroke-width="2"/></svg>`;

const FAVICON = `data:image/svg+xml;base64,${Buffer.from(BRAND_SVG.replace(' aria-hidden="true" class="brand-mark"', ' xmlns="http://www.w3.org/2000/svg"'), 'utf8').toString('base64')}`;

export function brand(href = '/'): string {
  return `<a class="brand" href="${href}">${BRAND_SVG}<span translate="no">École Directe MCP</span></a>`;
}

export interface PageOptions {
  title: string;
  body: string;
  /** Pages carrying one-shot ids or private data stay out of search engines. */
  noindex?: boolean;
  description?: string;
}

export function page({ title, body, noindex = true, description }: PageOptions): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · École Directe MCP</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="theme-color" content="#f4f7ff">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="${FAVICON}">
<link rel="preload" href="${STATIC_PREFIX}/fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${STATIC_PREFIX}/fonts/figtree-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${STATIC_PREFIX}/app.css?v=${ASSET_VERSION}">
<script src="${STATIC_PREFIX}/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
${body}
</body>
</html>`;
}

/** Stroke icons, 24×24, drawn for this project. */
const ICONS = {
  grades: '<path d="M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12"/><path d="M9 8h5M9 12h4"/>',
  homework: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  school: '<path d="M12 3 3 8l9 5 9-5z"/><path d="M7 10.5V15c0 1.7 2.2 3 5 3s5-1.3 5-3v-4.5"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1-3.8 4-5.5 7.5-5.5s6.5 1.7 7.5 5.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.5 11.5 8-8M16 7l2.5 2.5"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3v3.5l4 5.5-4 5.5V21M16 3v3.5L12 12l4 5.5V21"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, label?: string): string {
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${ICONS[name]}</svg>`;
}

/** "il y a 3 min", "hier à 18:04", "le 12/11 à 09:30": times as people say them, in Paris time. */
export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return 'jamais';
  const at = Date.parse(iso);
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 12) return `il y a ${hours} h`;
  const parts = (ms: number) =>
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(ms)
      .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const p = parts(at);
  const today = parts(now);
  const yesterday = parts(now - 24 * 60 * 60 * 1000);
  const time = `${p.hour}:${p.minute}`;
  if (p.day === today.day && p.month === today.month) return `aujourd'hui à ${time}`;
  if (p.day === yesterday.day && p.month === yesterday.month) return `hier à ${time}`;
  return `le ${p.day}/${p.month} à ${time}`;
}

/** Up to two initials, for the avatar circles. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0][0], words[words.length - 1][0]] : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase();
}
