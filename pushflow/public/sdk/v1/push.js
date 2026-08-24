/*!
 * PushFlow Web SDK v1.0.0
 * Integración en una línea:
 *   <script src="https://TU-SERVIDOR/sdk/v1/push.js" data-app-id="TU-APP-ID" async></script>
 *
 * Requisitos: HTTPS (o localhost) y un fichero `/pushflow-sw.js` en la raíz del
 * sitio con una única línea:
 *   importScripts('https://TU-SERVIDOR/sdk/v1/pushflow-sw.js');
 */
(function (window, document) {
  'use strict';

  var VERSION = '1.0.0';
  var STORE = 'pushflow:v1';

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------
  function store(patch) {
    try {
      var current = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (!patch) return current;
      for (var key in patch) current[key] = patch[key];
      localStorage.setItem(STORE, JSON.stringify(current));
      return current;
    } catch (e) { return patch || {}; }
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
    return output;
  }

  function request(url, options) {
    options = options || {};
    return fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'omit',
      mode: 'cors',
      keepalive: options.keepalive || false,
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function log() {
    if (!PushFlow._debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[PushFlow]');
    console.log.apply(console, args);
  }

  // -------------------------------------------------------------------------
  // Objeto principal
  // -------------------------------------------------------------------------
  var PushFlow = {
    VERSION: VERSION,
    _config: null,
    _ready: null,
    _listeners: {},
    _debug: false,
    _registration: null,

    /** Inicializa el SDK. Se llama solo si usas la etiqueta script con data-app-id. */
    init: function (options) {
      options = options || {};
      if (this._ready) return this._ready;

      var appId = options.appId || options.app_id;
      var apiUrl = (options.apiUrl || options.api_url || currentScriptOrigin()).replace(/\/$/, '');
      if (!appId) { console.error('[PushFlow] Falta appId'); return Promise.reject(new Error('appId requerido')); }

      this._debug = Boolean(options.debug);
      this._ready = request(apiUrl + '/sdk/v1/config?app_id=' + encodeURIComponent(appId))
        .then(function (config) {
          PushFlow._config = Object.assign({}, config, options, { app_id: appId, api_url: apiUrl });
          log('configuración cargada', PushFlow._config);

          if (!isSupported()) {
            log('este navegador no admite Web Push');
            PushFlow._emit('unsupported', {});
            return PushFlow;
          }
          return registerServiceWorker()
            .then(function () { return syncExistingSubscription(); })
            .then(function () {
              startSession();
              if (PushFlow._config.in_app_enabled) scheduleInApp();
              maybePrompt();
              PushFlow._emit('ready', { subscribed: PushFlow.isSubscribed() });
              return PushFlow;
            });
        })
        .catch(function (err) {
          console.error('[PushFlow] error de inicialización:', err.message);
          throw err;
        });
      return this._ready;
    },

    /** ¿El navegador admite notificaciones push? */
    isSupported: function () { return isSupported(); },

    /** ¿Este dispositivo está suscrito y activo? */
    isSubscribed: function () {
      return Notification.permission === 'granted' && Boolean(store().subscriptionId) && !store().optedOut;
    },

    getSubscriptionId: function () { return store().subscriptionId || null; },

    getPermission: function () {
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    },

    /** Muestra el prompt configurado en el panel (o el nativo). */
    showPrompt: function () {
      return this._ready.then(function () {
        var prompt = PushFlow._config.prompt || {};
        if (Notification.permission === 'granted') return PushFlow.subscribe();
        if (Notification.permission === 'denied') {
          log('el usuario bloqueó las notificaciones en el navegador');
          return Promise.resolve(false);
        }
        if (prompt.type === 'native') return PushFlow.subscribe();
        return showSlidePrompt(prompt);
      });
    },

    /** Pide permiso al navegador y registra la suscripción. */
    subscribe: function () {
      return this._ready.then(function () {
        return Notification.requestPermission();
      }).then(function (permission) {
        trackEvent({ type: 'permission_prompt', properties: { result: permission } });
        if (permission !== 'granted') {
          PushFlow._emit('permissionDenied', { permission: permission });
          return false;
        }
        return subscribeToPush().then(function (subscriptionId) {
          PushFlow._emit('subscribed', { subscriptionId: subscriptionId });
          return subscriptionId;
        });
      });
    },

    /** Desactiva las notificaciones sin borrar el historial del usuario. */
    optOut: function (value) {
      var optedOut = value !== false;
      store({ optedOut: optedOut });
      var id = store().subscriptionId;
      if (!id) return Promise.resolve(true);
      return api('PATCH', '/sdk/v1/subscription/' + id, { subscribed: !optedOut })
        .then(function () { PushFlow._emit(optedOut ? 'optedOut' : 'optedIn', {}); return true; });
    },

    /** Baja definitiva de este dispositivo. */
    unsubscribe: function () {
      var id = store().subscriptionId;
      return (PushFlow._registration ? PushFlow._registration.pushManager.getSubscription() : Promise.resolve(null))
        .then(function (sub) { return sub ? sub.unsubscribe() : null; })
        .then(function () { return id ? api('DELETE', '/sdk/v1/subscription/' + id) : null; })
        .then(function () {
          store({ subscriptionId: null, optedOut: true });
          PushFlow._emit('unsubscribed', {});
          return true;
        });
    },

    // --- Identidad y tags ---------------------------------------------------
    setExternalUserId: function (externalId) {
      store({ externalUserId: externalId });
      return patchSubscription({ external_user_id: String(externalId) });
    },
    removeExternalUserId: function () {
      store({ externalUserId: null });
      return patchSubscription({ external_user_id: null });
    },
    sendTag: function (key, value) {
      var tags = {}; tags[key] = value;
      return this.sendTags(tags);
    },
    sendTags: function (tags) {
      var local = store().tags || {};
      for (var key in tags) local[key] = tags[key];
      store({ tags: local });
      return patchSubscription({ tags: tags });
    },
    getTags: function () { return store().tags || {}; },
    deleteTag: function (key) { var t = {}; t[key] = null; return this.sendTags(t); },
    deleteTags: function (keys) {
      var tags = {};
      (keys || []).forEach(function (key) { tags[key] = null; });
      return this.sendTags(tags);
    },

    /** Registra una conversión atribuible a la última notificación. */
    addOutcome: function (name, value) {
      return trackEvent({ type: 'outcome', name: name, value: value == null ? 1 : Number(value) });
    },

    /** Evento personalizado que puede disparar automatizaciones. */
    trackEvent: function (name, properties) {
      return trackEvent({ type: 'custom', name: name, properties: properties || {} });
    },

    // --- Eventos ------------------------------------------------------------
    on: function (event, callback) {
      (this._listeners[event] = this._listeners[event] || []).push(callback);
      return this;
    },
    _emit: function (event, data) {
      (this._listeners[event] || []).forEach(function (cb) {
        try { cb(data); } catch (e) { console.error('[PushFlow] error en listener', e); }
      });
    },
  };

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------
  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function currentScriptOrigin() {
    var script = document.currentScript || (function () {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('/sdk/v1/push.js') !== -1) return scripts[i];
      }
      return null;
    })();
    return script ? new URL(script.src).origin : window.location.origin;
  }

  function api(method, path, body) {
    var payload = Object.assign({ app_id: PushFlow._config.app_id }, body || {});
    var url = PushFlow._config.api_url + path;
    if (method === 'GET' || method === 'DELETE') {
      url += (path.indexOf('?') === -1 ? '?' : '&') + 'app_id=' + encodeURIComponent(PushFlow._config.app_id);
      return request(url, { method: method });
    }
    return request(url, { method: method, body: payload });
  }

  function registerServiceWorker() {
    var path = PushFlow._config.service_worker_path || '/pushflow-sw.js';
    var scope = PushFlow._config.service_worker_scope || '/';
    return navigator.serviceWorker.register(path, { scope: scope })
      .then(function (registration) {
        PushFlow._registration = registration;
        log('service worker registrado', registration.scope);
        return navigator.serviceWorker.ready;
      })
      .then(function (registration) {
        PushFlow._registration = registration;
        // El SW envía los clics para que la página pueda reaccionar.
        navigator.serviceWorker.addEventListener('message', function (event) {
          if (event.data && event.data.pushflow) PushFlow._emit(event.data.type, event.data.payload || {});
        });
        return registration;
      })
      .catch(function (err) {
        console.error('[PushFlow] no se pudo registrar el service worker en "' + path + '":', err.message);
        throw err;
      });
  }

  /** Envía al servidor la suscripción del navegador. */
  function subscribeToPush() {
    var registration = PushFlow._registration;
    return registration.pushManager.getSubscription()
      .then(function (existing) {
        if (existing) return existing;
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(PushFlow._config.vapid_public_key),
        });
      })
      .then(function (subscription) {
        var json = subscription.toJSON();
        return api('POST', '/sdk/v1/subscribe', {
          endpoint: json.endpoint,
          keys: json.keys,
          channel: 'web_push',
          language: (navigator.language || 'es').toLowerCase(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timezone_offset: -new Date().getTimezoneOffset(),
          sdk_version: VERSION,
          external_user_id: store().externalUserId || undefined,
          tags: store().tags || undefined,
        });
      })
      .then(function (result) {
        store({ subscriptionId: result.subscription_id, optedOut: false, subscribedAt: Date.now() });
        log('suscrito', result.subscription_id);
        return result.subscription_id;
      });
  }

  /** Si el navegador ya tenía permiso, mantiene la suscripción al día. */
  function syncExistingSubscription() {
    if (Notification.permission !== 'granted') return Promise.resolve();
    if (store().optedOut && PushFlow._config.auto_resubscribe === false) return Promise.resolve();
    return subscribeToPush().catch(function (err) { log('resincronización fallida', err.message); });
  }

  function patchSubscription(patch) {
    var id = store().subscriptionId;
    if (!id) return Promise.resolve(null);
    return api('PATCH', '/sdk/v1/subscription/' + id, patch);
  }

  function trackEvent(event) {
    if (!PushFlow._config) return Promise.resolve();
    var body = Object.assign({
      app_id: PushFlow._config.app_id,
      subscription_id: store().subscriptionId || null,
      channel: 'web_push',
    }, event);
    var url = PushFlow._config.api_url + '/api/v1/events';
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: 'application/json' }));
      return Promise.resolve();
    }
    return request(url, { method: 'POST', body: body, keepalive: true }).catch(function () {});
  }

  /** Sesiones: sirven para segmentar por actividad y para los mensajes in-app. */
  function startSession() {
    var id = store().subscriptionId;
    if (!id) return;
    var startedAt = Date.now();
    api('POST', '/sdk/v1/session', { subscription_id: id, start: true }).catch(function () {});
    window.addEventListener('pagehide', function () {
      var duration = Math.round((Date.now() - startedAt) / 1000);
      var body = JSON.stringify({ app_id: PushFlow._config.app_id, subscription_id: id,
                                  start: false, duration: duration });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(PushFlow._config.api_url + '/sdk/v1/session',
          new Blob([body], { type: 'application/json' }));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Prompt de permiso (deslizante o campana)
  // -------------------------------------------------------------------------
  function maybePrompt() {
    var prompt = PushFlow._config.prompt || {};
    if (prompt.type === 'manual') return;
    if (Notification.permission !== 'default') return;

    var state = store();
    var views = (state.pageViews || 0) + 1;
    store({ pageViews: views });
    if (views < (prompt.page_views || 1)) return;

    if (state.promptDismissedAt) {
      var days = (Date.now() - state.promptDismissedAt) / 86400000;
      if (days < (prompt.remind_after_days || 7)) return;
    }
    if (prompt.type === 'bell') return showBell(prompt);
    setTimeout(function () { PushFlow.showPrompt(); }, (prompt.delay_seconds || 5) * 1000);
  }

  function injectStyles() {
    if (document.getElementById('pushflow-styles')) return;
    var style = document.createElement('style');
    style.id = 'pushflow-styles';
    style.textContent = [
      '.pf-slide{position:fixed;z-index:2147483000;left:50%;transform:translateX(-50%);top:16px;',
      'max-width:min(440px,calc(100vw - 32px));width:100%;background:#fff;color:#1a1a1a;',
      'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:16px 18px;',
      'font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;gap:14px;',
      'align-items:flex-start;animation:pf-in .28s ease}',
      '@keyframes pf-in{from{opacity:0;transform:translate(-50%,-14px)}to{opacity:1;transform:translate(-50%,0)}}',
      '.pf-slide img{width:44px;height:44px;border-radius:10px;flex:none;object-fit:cover}',
      '.pf-slide h4{margin:0 0 4px;font-size:15px;font-weight:600}',
      '.pf-slide p{margin:0 0 12px;color:#555}',
      '.pf-slide button{border:0;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;',
      'cursor:pointer;font-family:inherit}',
      '.pf-yes{background:#2563eb;color:#fff;margin-right:8px}.pf-yes:hover{background:#1d4ed8}',
      '.pf-no{background:transparent;color:#666}.pf-no:hover{color:#111}',
      '.pf-bell{position:fixed;z-index:2147483000;width:52px;height:52px;border-radius:50%;',
      'background:#2563eb;color:#fff;border:0;cursor:pointer;box-shadow:0 6px 20px rgba(37,99,235,.4);',
      'display:flex;align-items:center;justify-content:center;font-size:22px;transition:transform .2s}',
      '.pf-bell:hover{transform:scale(1.08)}',
      '@media (prefers-color-scheme:dark){.pf-slide{background:#1c1c1e;color:#f2f2f2}',
      '.pf-slide p{color:#aaa}.pf-no{color:#999}}',
    ].join('');
    document.head.appendChild(style);
  }

  function showSlidePrompt(prompt) {
    injectStyles();
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.className = 'pf-slide';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-live', 'polite');

      var icon = PushFlow._config.default_icon;
      box.innerHTML =
        (icon ? '<img src="' + escapeHtml(icon) + '" alt="">' : '<div style="font-size:34px">🔔</div>') +
        '<div style="flex:1">' +
        '<h4>' + escapeHtml(prompt.title || '¿Quieres recibir notificaciones?') + '</h4>' +
        '<p>' + escapeHtml(prompt.message || 'Te avisaremos solo de lo importante.') + '</p>' +
        '<button class="pf-yes">' + escapeHtml(prompt.accept_text || 'Permitir') + '</button>' +
        '<button class="pf-no">' + escapeHtml(prompt.cancel_text || 'Ahora no') + '</button>' +
        '</div>';

      box.querySelector('.pf-yes').onclick = function () {
        box.remove();
        PushFlow.subscribe().then(resolve);
      };
      box.querySelector('.pf-no').onclick = function () {
        box.remove();
        store({ promptDismissedAt: Date.now() });
        trackEvent({ type: 'permission_prompt', properties: { result: 'dismissed' } });
        resolve(false);
      };
      document.body.appendChild(box);
      trackEvent({ type: 'permission_prompt', properties: { result: 'shown' } });
    });
  }

  function showBell(prompt) {
    injectStyles();
    var bell = document.createElement('button');
    bell.className = 'pf-bell';
    bell.setAttribute('aria-label', 'Activar notificaciones');
    bell.textContent = '🔔';
    var position = prompt.bell_position || 'bottom-right';
    bell.style[position.indexOf('bottom') === 0 ? 'bottom' : 'top'] = '20px';
    bell.style[position.indexOf('right') !== -1 ? 'right' : 'left'] = '20px';
    bell.onclick = function () {
      showSlidePrompt(prompt).then(function (result) { if (result) bell.remove(); });
    };
    document.body.appendChild(bell);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  // -------------------------------------------------------------------------
  // Mensajes in-app
  // -------------------------------------------------------------------------
  function scheduleInApp() {
    var id = store().subscriptionId;
    if (!id) return;
    setTimeout(function () {
      request(PushFlow._config.api_url + '/sdk/v1/in-app?app_id=' +
              encodeURIComponent(PushFlow._config.app_id) + '&subscription_id=' + id)
        .then(function (data) {
          if (data && data.messages && data.messages.length) renderInApp(data.messages[0]);
        })
        .catch(function () {});
    }, 3000);
  }

  function renderInApp(message) {
    injectStyles();
    var content = message.content || {};
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);' +
      'display:flex;align-items:center;justify-content:center;padding:20px';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#111;border-radius:16px;max-width:420px;width:100%;' +
      'overflow:hidden;font:14px/1.5 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.3)';
    card.innerHTML =
      (content.image ? '<img src="' + escapeHtml(content.image) + '" style="width:100%;display:block">' : '') +
      '<div style="padding:20px">' +
      (content.title ? '<h3 style="margin:0 0 8px;font-size:18px">' + escapeHtml(content.title) + '</h3>' : '') +
      (content.body ? '<p style="margin:0 0 16px;color:#555">' + escapeHtml(content.body) + '</p>' : '') +
      '<div class="pf-actions"></div></div>';

    var actions = card.querySelector('.pf-actions');
    (content.buttons || [{ text: 'Cerrar' }]).forEach(function (button) {
      var element = document.createElement('button');
      element.className = 'pf-yes';
      element.textContent = button.text || 'Aceptar';
      element.onclick = function () {
        api('POST', '/sdk/v1/in-app/' + message.id + '/event',
          { subscription_id: store().subscriptionId, type: 'click' }).catch(function () {});
        if (button.url) window.open(button.url, button.target || '_self');
        overlay.remove();
      };
      actions.appendChild(element);
    });

    overlay.onclick = function (event) { if (event.target === overlay) overlay.remove(); };
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    api('POST', '/sdk/v1/in-app/' + message.id + '/event',
      { subscription_id: store().subscriptionId, type: 'display' }).catch(function () {});
  }

  // -------------------------------------------------------------------------
  // Arranque automático
  // -------------------------------------------------------------------------
  window.PushFlow = PushFlow;

  // Cola de llamadas anteriores a la carga: window.pushflow = window.pushflow || [];
  var queue = window.pushflow;
  if (Array.isArray(queue)) {
    window.pushflow = { push: function (args) { runQueued(args); } };
    queue.forEach(runQueued);
  }
  function runQueued(args) {
    if (!Array.isArray(args)) return;
    var method = args[0];
    if (typeof PushFlow[method] === 'function') PushFlow[method].apply(PushFlow, args.slice(1));
  }

  // Inicialización declarativa desde el atributo data-app-id del <script>.
  var script = document.currentScript;
  if (script && script.getAttribute('data-app-id')) {
    var options = {
      appId: script.getAttribute('data-app-id'),
      apiUrl: script.getAttribute('data-api-url') || new URL(script.src).origin,
      debug: script.getAttribute('data-debug') === 'true',
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { PushFlow.init(options); });
    } else {
      PushFlow.init(options);
    }
  }
})(window, document);
