/**
 * Detección ligera de navegador/SO a partir del User-Agent.
 * Suficiente para segmentar y para los desgloses de analítica, sin dependencias.
 */
const BROWSERS = [
  [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'edge'],
  [/OPR\/([\d.]+)/, 'opera'],
  [/SamsungBrowser\/([\d.]+)/, 'samsung'],
  [/YaBrowser\/([\d.]+)/, 'yandex'],
  [/Firefox\/([\d.]+)/, 'firefox'],
  [/FxiOS\/([\d.]+)/, 'firefox'],
  [/CriOS\/([\d.]+)/, 'chrome'],
  [/Chrome\/([\d.]+)/, 'chrome'],
  [/Version\/([\d.]+).*Safari/, 'safari'],
  [/Safari\/([\d.]+)/, 'safari'],
];

const OSES = [
  [/Windows NT ([\d.]+)/, 'windows'],
  [/Android[ /]([\d.]+)/, 'android'],
  [/(?:iPhone|iPad|iPod).*OS ([\d_]+)/, 'ios'],
  [/Mac OS X ([\d_.]+)/, 'macos'],
  [/CrOS \S+ ([\d.]+)/, 'chromeos'],
  [/Linux/, 'linux'],
];

export function parseUserAgent(ua = '') {
  const result = {
    browserName: null, browserVersion: null,
    os: null, osVersion: null,
    deviceType: 'desktop', isMobile: false,
  };
  if (!ua) return result;

  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (m) { result.browserName = name; result.browserVersion = m[1] || null; break; }
  }
  for (const [re, name] of OSES) {
    const m = re.exec(ua);
    if (m) { result.os = name; result.osVersion = (m[1] || '').replace(/_/g, '.') || null; break; }
  }
  if (/Mobile|Android|iPhone|iPod/i.test(ua)) { result.deviceType = 'mobile'; result.isMobile = true; }
  else if (/iPad|Tablet/i.test(ua)) { result.deviceType = 'tablet'; result.isMobile = true; }
  return result;
}

/** Deriva el proveedor de push a partir del endpoint (útil para diagnóstico). */
export function pushProvider(endpoint = '') {
  if (endpoint.includes('fcm.googleapis.com') || endpoint.includes('android.googleapis.com')) return 'fcm';
  if (endpoint.includes('mozilla.com') || endpoint.includes('mozaws.net')) return 'mozilla';
  if (endpoint.includes('windows.com') || endpoint.includes('notify.windows')) return 'wns';
  if (endpoint.includes('push.apple.com')) return 'apple';
  return 'unknown';
}

export default { parseUserAgent, pushProvider };
