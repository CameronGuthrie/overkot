/** Desktop catalogue artwork always goes through the main-process data protocol. */
export function imageUrlForPath(value: string | null | undefined): string | null {
  if (!value || value.length > 1000 || /[%\\?#\u0000-\u0020\u007f]/.test(value)) return null;
  const base = 'overkot-game-data://images';
  let path = value;
  for (const prefix of [base, 'https://dap1x6lmnonv6.cloudfront.net',
    'https://avakot.market/api/v1/data-assets', '/api/v1/data-assets']) {
    if (path.startsWith(prefix + '/')) { path = path.slice(prefix.length); break; }
  }
  if (path.startsWith('SF/Interface/Graphics/')) path = '/' + path;
  if (!/^\/SF\/Interface\/Graphics\/[A-Za-z0-9_./-]+\.(?:png|webp)$/.test(path)
    || path.split('/').some(part => part === '.' || part === '..')) return null;
  return base + path;
}
