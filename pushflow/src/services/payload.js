/**
 * Construcción del payload que viaja a cada dispositivo.
 *
 * El payload de Web Push va cifrado y está limitado (~4 KB), por eso se usan
 * claves cortas. El SDK las expande antes de llamar a `showNotification`.
 */
import config from '../config.js';

/** Elige el texto del idioma del dispositivo con degradación en cascada. */
export function pickLanguage(map, language) {
  if (!map || typeof map !== 'object') return '';
  const keys = Object.keys(map);
  if (keys.length === 0) return '';
  if (language) {
    const lang = String(language).toLowerCase();
    if (map[lang] != null) return map[lang];
    const base = lang.split('-')[0];
    if (map[base] != null) return map[base];
    const prefixed = keys.find((k) => k.split('-')[0] === base);
    if (prefixed) return map[prefixed];
  }
  if (map.en != null) return map.en;
  return map[keys[0]];
}

/** Aplica la variante A/B seleccionada sobre la notificación base. */
export function applyVariant(notification, variantId) {
  if (!variantId || !notification.ab_test?.variants) return notification;
  const variant = notification.ab_test.variants.find((v) => String(v.id) === String(variantId));
  if (!variant) return notification;
  return { ...notification, ...variant, id: notification.id, ab_test: notification.ab_test };
}

/** Sustituye {{tag}} y {{external_id}} por los datos de la suscripción. */
export function interpolate(text, subscription) {
  if (!text || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*))?\}\}/g, (_, key, fallback) => {
    if (key === 'external_id' || key === 'external_user_id') {
      return subscription.external_user_id || fallback || '';
    }
    if (key === 'country') return subscription.country || fallback || '';
    if (key === 'language') return subscription.language || fallback || '';
    const tagKey = key.startsWith('tags.') ? key.slice(5) : key;
    const value = subscription.tags?.[tagKey];
    return value != null && value !== '' ? String(value) : (fallback || '').trim();
  });
}

/** URL de destino al pulsar, según canal. */
export function targetUrl(n, channel) {
  if (channel === 'android') return n.app_url || n.url || n.web_url || null;
  return n.web_url || n.url || null;
}

/**
 * Payload compacto para Web Push.
 * Claves: i=id, t=title, b=body, ic=icon, im=image, bd=badge, u=url,
 *         a=actions, d=data, g=tag(group), ri=requireInteraction, si=silent,
 *         v=vibrate, ts=timestamp, e=endpoint de tracking, dl=delivery id.
 */
export function buildWebPushPayload(notification, subscription, { variant, deliveryId } = {}) {
  const n = applyVariant(notification, variant);
  const lang = subscription.language;
  const title = interpolate(pickLanguage(n.headings, lang), subscription);
  const body = interpolate(pickLanguage(n.contents, lang), subscription);

  const payload = {
    i: n.id,
    ap: n.app_id,
    t: title || '',
    b: body || '',
    ts: Date.now(),
    e: `${config.server.publicUrl}/api/v1/events`,
  };

  if (deliveryId) payload.dl = String(deliveryId);
  if (variant) payload.vr = variant;
  // Sin icono propio, la notificación saldría con el genérico del navegador.
  payload.ic = n.icon_url || `${config.server.publicUrl}${config.brand.defaultIcon}`;
  payload.bd = n.badge_url || `${config.server.publicUrl}${config.brand.defaultBadge}`;
  if (n.image_url) payload.im = n.image_url;

  const url = targetUrl(n, 'web_push');
  if (url) payload.u = interpolate(url, subscription);
  if (n.collapse_id) payload.g = n.collapse_id;
  if (n.require_interaction) payload.ri = 1;
  if (n.silent) payload.si = 1;
  if (Array.isArray(n.vibration_pattern) && n.vibration_pattern.length) payload.v = n.vibration_pattern;

  if (Array.isArray(n.buttons) && n.buttons.length) {
    payload.a = n.buttons.slice(0, 3).map((btn, idx) => ({
      i: btn.id || `btn${idx}`,
      t: interpolate(pickLanguage(
        typeof btn.text === 'object' ? btn.text : { en: btn.text }, lang), subscription),
      ...(btn.icon ? { c: btn.icon } : {}),
      ...(btn.url ? { u: btn.url } : {}),
    }));
  }
  if (n.data && Object.keys(n.data).length) payload.d = n.data;
  if (n.subtitle && Object.keys(n.subtitle).length) {
    payload.st = pickLanguage(n.subtitle, lang);
  }
  return payload;
}

/**
 * Mensaje FCM HTTP v1 (data-only): el SDK de Android construye la notificación,
 * lo que permite imágenes grandes, botones, deep links y registrar la recepción.
 */
export function buildFcmMessage(notification, subscription, { variant, deliveryId } = {}) {
  const n = applyVariant(notification, variant);
  const lang = subscription.language;
  const title = interpolate(pickLanguage(n.headings, lang), subscription);
  const body = interpolate(pickLanguage(n.contents, lang), subscription);
  const url = targetUrl(n, 'android');

  // FCM exige que todos los valores de `data` sean strings.
  const data = {
    pf_id: String(n.id),
    pf_title: title || '',
    pf_body: body || '',
    pf_ts: String(Date.now()),
    pf_api: config.server.publicUrl,
  };
  if (deliveryId) data.pf_delivery = String(deliveryId);
  if (variant) data.pf_variant = String(variant);
  data.pf_icon = n.icon_url || `${config.server.publicUrl}${config.brand.defaultIcon}`;
  if (n.image_url) data.pf_image = n.image_url;
  if (n.large_icon) data.pf_large_icon = n.large_icon;
  if (url) data.pf_url = interpolate(url, subscription);
  if (n.launch_activity) data.pf_activity = n.launch_activity;
  if (n.android_channel_id) data.pf_channel = n.android_channel_id;
  if (n.android_sound) data.pf_sound = n.android_sound;
  if (n.android_accent_color) data.pf_color = n.android_accent_color;
  if (n.android_group) data.pf_group = n.android_group;
  if (n.android_visibility != null) data.pf_visibility = String(n.android_visibility);
  if (n.collapse_id) data.pf_collapse = n.collapse_id;
  if (Array.isArray(n.vibration_pattern) && n.vibration_pattern.length) {
    data.pf_vibrate = n.vibration_pattern.join(',');
  }
  if (n.subtitle && Object.keys(n.subtitle).length) {
    data.pf_subtitle = pickLanguage(n.subtitle, lang);
  }
  if (Array.isArray(n.buttons) && n.buttons.length) {
    data.pf_buttons = JSON.stringify(n.buttons.slice(0, 3).map((btn, idx) => ({
      id: btn.id || `btn${idx}`,
      text: pickLanguage(typeof btn.text === 'object' ? btn.text : { en: btn.text }, lang),
      icon: btn.icon || null,
      url: btn.url || null,
    })));
  }
  if (n.data && Object.keys(n.data).length) data.pf_data = JSON.stringify(n.data);

  const message = {
    token: subscription.fcm_token,
    data,
    android: {
      priority: n.priority >= 8 ? 'HIGH' : 'NORMAL',
      ttl: `${Math.max(0, Math.min(n.ttl ?? 259200, 2419200))}s`,
    },
  };
  if (n.collapse_id) message.android.collapse_key = n.collapse_id;
  return message;
}

export default {
  pickLanguage, applyVariant, interpolate, targetUrl,
  buildWebPushPayload, buildFcmMessage,
};
