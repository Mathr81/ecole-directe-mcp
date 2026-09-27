/**
 * The server's icon, advertised in serverInfo (MCP spec 2025-11-25, SEP-973).
 *
 * Claude.ai does not read it for custom connectors yet — it shows the favicon
 * of the URL's last two labels, which for this deployment is DuckDNS's
 * (anthropics/claude-ai-mcp#152, #838). It is inlined as a data URI so that,
 * once clients do read it, nothing has to be fetched past the IP allowlist.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#1e4fa3"/>
<path d="M32 14 5 26l27 12 27-12z" fill="#fff"/>
<path d="M16 32v10c0 4.4 7.2 8 16 8s16-3.6 16-8V32l-16 7.1z" fill="#fff"/>
<path d="M55 27v14" stroke="#ffc83d" stroke-width="3" stroke-linecap="round"/>
<circle cx="55" cy="43" r="3.5" fill="#ffc83d"/>
</svg>`;

export const SERVER_ICONS = [
  {
    src: `data:image/svg+xml;base64,${Buffer.from(SVG, 'utf8').toString('base64')}`,
    mimeType: 'image/svg+xml',
    sizes: ['any'],
  },
];
