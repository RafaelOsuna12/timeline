/*!
 * PushFlow Service Worker v1.0.0
 *
 * En el sitio del cliente basta con un fichero `/pushflow-sw.js` que contenga:
 *   importScripts('https://TU-SERVIDOR/sdk/v1/pushflow-sw.js');
 *
 * Se encarga de mostrar la notificación (título, texto, emojis, imagen y
 * botones) y de reportar recepción, clic y descarte para la analítica.
 */
'use strict';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

/** Expande el payload compacto que envía el servidor. */
function expand(raw) {
  var data = {};
  try { data = raw ? raw.json() : {}; } catch (e) {
    try { data = { t: 'Notificación', b: raw.text() }; } catch (e2) { data = {}; }
  }
  return {
    id: data.i || null,
    appId: data.ap || null,
    deliveryId: data.dl || null,
    variant: data.vr || null,
    title: data.t || '',
    body: data.b || '',
    subtitle: data.st || null,
    icon: data.ic || null,
    image: data.im || null,
    badge: data.bd || null,
    url: data.u || null,
    tag: data.g || null,
    requireInteraction: data.ri === 1,
    silent: data.si === 1,
    vibrate: data.v || null,
    actions: data.a || [],
    custom: data.d || {},
    timestamp: data.ts || Date.now(),
    endpoint: data.e || null,
  };
}

/** Envía un evento de analítica al servidor. */
function report(payload, type, extra) {
  if (!payload.endpoint || !payload.id) return Promise.resolve();
  var body = {
    type: type,
    app_id: payload.appId,
    notification_id: payload.id,
    delivery_id: payload.deliveryId,
    channel: 'web_push',
  };
  if (extra) for (var key in extra) body[key] = extra[key];

  return fetch(payload.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
    mode: 'cors',
  }).catch(function () { /* la analítica nunca debe romper la notificación */ });
}

self.addEventListener('push', function (event) {
  var payload = expand(event.data);
  if (!payload.title && !payload.body) return;

  var options = {
    body: payload.body,
    icon: payload.icon || undefined,
    badge: payload.badge || undefined,
    image: payload.image || undefined,
    tag: payload.tag || payload.id || undefined,
    renotify: Boolean(payload.tag),
    requireInteraction: payload.requireInteraction,
    silent: payload.silent,
    vibrate: payload.vibrate || undefined,
    timestamp: payload.timestamp,
    dir: 'auto',
    data: {
      id: payload.id,
      appId: payload.appId,
      deliveryId: payload.deliveryId,
      url: payload.url,
      endpoint: payload.endpoint,
      custom: payload.custom,
      actions: payload.actions,
    },
    actions: (payload.actions || []).slice(0, 3).map(function (action) {
      return { action: action.i, title: action.t, icon: action.c || undefined };
    }),
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
      .then(function () { return report(payload, 'displayed'); })
  );
});

self.addEventListener('notificationclick', function (event) {
  var data = event.notification.data || {};
  var actionId = event.action || null;

  // Si se pulsó un botón con URL propia, tiene prioridad.
  var targetUrl = data.url;
  if (actionId && Array.isArray(data.actions)) {
    for (var i = 0; i < data.actions.length; i++) {
      if (data.actions[i].i === actionId && data.actions[i].u) { targetUrl = data.actions[i].u; break; }
    }
  }
  event.notification.close();

  var payload = { id: data.id, appId: data.appId, deliveryId: data.deliveryId,
                  endpoint: data.endpoint, custom: data.custom };

  event.waitUntil(Promise.all([
    report(payload, 'clicked', { action_id: actionId, url: targetUrl }),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Avisa a las pestañas abiertas por si la web quiere reaccionar al clic.
      clientList.forEach(function (client) {
        client.postMessage({ pushflow: true, type: 'notificationClick',
                             payload: { notificationId: data.id, actionId: actionId, url: targetUrl,
                                        data: data.custom } });
      });
      if (!targetUrl) {
        return clientList.length ? clientList[0].focus() : null;
      }
      // Reutiliza una pestaña del mismo origen si ya está abierta.
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url === targetUrl && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return null;
    }),
  ]));
});

self.addEventListener('notificationclose', function (event) {
  var data = event.notification.data || {};
  event.waitUntil(report(
    { id: data.id, appId: data.appId, deliveryId: data.deliveryId,
      endpoint: data.endpoint, custom: data.custom },
    'dismissed'));
});

/**
 * Renovación automática de la suscripción cuando el navegador la rota.
 * Sin esto, el dispositivo se perdería silenciosamente.
 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    self.registration.pushManager.subscribe(event.oldSubscription
      ? { userVisibleOnly: true, applicationServerKey: event.oldSubscription.options.applicationServerKey }
      : { userVisibleOnly: true })
      .then(function (subscription) {
        var json = subscription.toJSON();
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(function (clientList) {
            clientList.forEach(function (client) {
              client.postMessage({ pushflow: true, type: 'subscriptionChange',
                                   payload: { endpoint: json.endpoint, keys: json.keys } });
            });
          });
      })
      .catch(function () {})
  );
});
