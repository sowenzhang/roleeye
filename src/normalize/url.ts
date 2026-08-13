/** Query params that identify a campaign, not a posting. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^gh_src$/i,
  /^gh_jid$/i,
  /^lever-/i,
  /^ref$/i,
  /^source$/i,
  /^src$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_[a-z]+$/i,
  /^trk$/i,
  /^trackingId$/i,
];

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAMS.some((pattern) => pattern.test(key));
}

/**
 * Canonicalizes a posting URL so the same job discovered through different
 * campaigns resolves to one identity. Returns undefined for unusable input
 * rather than throwing, because adapters see messy data.
 */
export function canonicalizeUrl(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  url.username = '';
  url.password = '';
  if (url.port === '80' || url.port === '443') url.port = '';

  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}

export function hostOf(input: string | undefined): string | undefined {
  const canonical = canonicalizeUrl(input);
  if (!canonical) return undefined;
  try {
    return new URL(canonical).hostname;
  } catch {
    return undefined;
  }
}

/** Which ATS a URL points at. Used for application-system deny lists. */
export function detectApplicationSystem(url: string | undefined): string | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  if (host.includes('greenhouse.io')) return 'greenhouse';
  if (host.includes('lever.co')) return 'lever';
  if (host.includes('ashbyhq.com')) return 'ashby';
  if (host.includes('myworkdayjobs.com') || host.includes('workday')) return 'workday';
  if (host.includes('icims.com')) return 'icims';
  if (host.includes('taleo.net')) return 'taleo';
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (host.includes('jobvite.com')) return 'jobvite';
  if (host.includes('workable.com')) return 'workable';
  return undefined;
}
