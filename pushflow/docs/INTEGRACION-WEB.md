# Integración en una página web

## Lo mínimo

**1. Sube el service worker.** Crea un fichero `pushflow-sw.js` en la **raíz**
de tu dominio (debe responder en `https://tudominio.com/pushflow-sw.js`) con
una sola línea:

```js
importScripts('https://push.tudominio.com/sdk/v1/pushflow-sw.js');
```

Así el service worker se actualiza solo cuando actualices PushFlow.

> Tiene que estar en la raíz porque el ámbito de un service worker no puede
> subir de su propia carpeta: uno servido desde `/js/` solo controlaría `/js/`.

**2. Añade el script** antes de `</body>`, en todas las páginas:

```html
<script src="https://push.tudominio.com/sdk/v1/push.js"
        data-app-id="TU-APP-ID" async></script>
```

Con eso ya funciona: el prompt aparece según lo configurado en el panel, el
dispositivo se registra y la analítica empieza a llegar.

---

## Integraciones por plataforma

### WordPress

En `functions.php` del tema hijo:

```php
add_action('wp_footer', function () {
    ?>
    <script src="https://push.tudominio.com/sdk/v1/push.js"
            data-app-id="TU-APP-ID" async></script>
    <?php
});
```

Y crea `pushflow-sw.js` en la raíz de la instalación (junto a `wp-config.php`).
Si usas un plugin de caché, excluye ese fichero.

Para identificar al usuario que ha iniciado sesión:

```php
add_action('wp_footer', function () {
    if (!is_user_logged_in()) return;
    $user_id = get_current_user_id();
    ?>
    <script>
      window.pushflow = window.pushflow || [];
      window.addEventListener('load', function () {
        PushFlow.on('ready', function () {
          PushFlow.setExternalUserId('<?php echo esc_js($user_id); ?>');
        });
      });
    </script>
    <?php
});
```

### Shopify

En `theme.liquid`, antes de `</body>`:

```liquid
<script src="https://push.tudominio.com/sdk/v1/push.js"
        data-app-id="TU-APP-ID" async></script>
{% if customer %}
<script>
  window.addEventListener('load', function () {
    PushFlow.on('ready', function () {
      PushFlow.setExternalUserId('{{ customer.id }}');
      PushFlow.sendTags({ pedidos: '{{ customer.orders_count }}' });
    });
  });
</script>
{% endif %}
```

El fichero `pushflow-sw.js` va en **Assets** y se expone en la raíz mediante una
redirección, o bien se sirve desde tu propio dominio.

### React / Next.js

```jsx
// components/PushFlow.jsx
import Script from 'next/script';

export default function PushFlowScript() {
  return (
    <Script
      src="https://push.tudominio.com/sdk/v1/push.js"
      data-app-id={process.env.NEXT_PUBLIC_PUSHFLOW_APP_ID}
      strategy="afterInteractive"
    />
  );
}
```

Coloca `pushflow-sw.js` en `public/`. Con el App Router, monta el componente en
`app/layout.jsx`.

### Vue / Nuxt

```js
// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [{
        src: 'https://push.tudominio.com/sdk/v1/push.js',
        'data-app-id': 'TU-APP-ID',
        async: true,
      }],
    },
  },
});
```

---

## API de JavaScript

```js
// Estado
PushFlow.isSupported()        // ¿el navegador admite Web Push?
PushFlow.isSubscribed()       // ¿este dispositivo está activo?
PushFlow.getPermission()      // 'default' | 'granted' | 'denied'
PushFlow.getSubscriptionId()

// Suscripción
PushFlow.showPrompt()         // muestra el aviso configurado
PushFlow.subscribe()          // pide permiso directamente
PushFlow.optOut(true)         // desactiva sin borrar el historial
PushFlow.unsubscribe()        // baja definitiva

// Identidad y segmentación
PushFlow.setExternalUserId('usuario-123')
PushFlow.removeExternalUserId()
PushFlow.sendTag('plan', 'pro')
PushFlow.sendTags({ ciudad: 'CDMX', nivel: 12 })
PushFlow.getTags()
PushFlow.deleteTag('nivel')

// Analítica
PushFlow.addOutcome('compra', 49.90)
PushFlow.trackEvent('carrito_abandonado', { importe: 120 })

// Eventos
PushFlow.on('ready',             (e) => console.log('SDK listo', e.subscribed));
PushFlow.on('subscribed',        (e) => console.log('id:', e.subscriptionId));
PushFlow.on('permissionDenied',  ()  => console.log('el usuario dijo que no'));
PushFlow.on('notificationClick', (e) => console.log('abrió', e.url, e.data));
PushFlow.on('unsupported',       ()  => console.log('navegador sin soporte'));
```

### Inicialización manual

Si prefieres controlar cuándo arranca, quita `data-app-id` y llama tú:

```js
PushFlow.init({
  appId: 'TU-APP-ID',
  apiUrl: 'https://push.tudominio.com',
  debug: true,
}).then(() => {
  // el SDK ya está listo
});
```

### Llamadas antes de que cargue el script

Como el script es `async`, puede que tu código se ejecute antes. Usa la cola:

```js
window.pushflow = window.pushflow || [];
window.pushflow.push(['setExternalUserId', 'usuario-123']);
window.pushflow.push(['sendTags', { plan: 'pro' }]);
```

---

## Personalizar el aviso de permiso

Todo se configura desde **Ajustes → Petición de permiso**, sin tocar código:

| Tipo | Comportamiento |
|---|---|
| `slide` | Aviso propio y, si acepta, el nativo. **Recomendado**: si rechaza, puedes volver a preguntar |
| `native` | Directamente el del navegador. Si lo rechaza, no hay segunda oportunidad |
| `bell` | Campana flotante; el usuario decide cuándo |
| `manual` | No se muestra nada; lo lanzas con `PushFlow.showPrompt()` |

También se ajustan el retraso, las páginas vistas mínimas, los días antes de
volver a preguntar y todos los textos.

> Pedir el permiso nada más entrar es la forma más rápida de perder al usuario.
> Con `slide`, un retraso de 5–15 segundos o tras la segunda página vista, la
> tasa de aceptación suele multiplicarse.

---

## Compatibilidad

| Navegador | Escritorio | Móvil |
|---|---|---|
| Chrome / Edge / Opera | Sí | Sí (Android) |
| Firefox | Sí | Sí (Android) |
| Samsung Internet | — | Sí |
| Safari | Sí (16.4+, macOS 13+) | Sí (iOS 16.4+, **solo si el usuario añade la web a la pantalla de inicio**) |

En navegadores sin soporte el SDK no hace nada y emite el evento `unsupported`.

---

## Comprobaciones cuando algo falla

1. **HTTPS obligatorio.** Solo `localhost` está exento.
2. **`/pushflow-sw.js` accesible**: ábrelo en el navegador; debe devolver
   JavaScript, no un 404 ni el HTML de tu web.
3. **Orígenes autorizados**: si en Ajustes tienes `https://tudominio.com`, la
   web servida en `https://www.tudominio.com` será rechazada. Añade ambos o usa
   `*.tudominio.com`.
4. **Permiso ya denegado**: si el usuario rechazó antes, `Notification.permission`
   vale `denied` y solo él puede revertirlo desde la configuración del sitio.
5. **Consola**: activa `data-debug="true"` en la etiqueta `<script>` para ver
   el detalle de cada paso.
