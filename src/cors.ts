// The site is served from another origin (GitHub Pages), so the browser only lets it call this API when the
// response says so. Only origins listed in ALLOWED_ORIGINS get these headers; everyone else gets none.
export function corsHeaders(origin: string | undefined, allowed: ReadonlySet<string>): Record<string, string> {
  if (!origin || !allowed.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

export function parseOrigins(list: string | undefined): Set<string> {
  return new Set((list ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean))
}
