# Marca PushFlow

Iconos generados a partir de `logo1.ai`. El maestro vectorial es
`logo-mark.svg`; todo lo demás deriva de él.

La marca es un anillo abierto con dos huecos en diagonal. Ocupa el 91 % de su
propia caja y su trazo mide el **17,3 %** del ancho, grosor suficiente para
seguir leyéndose a 24 px en la barra de estado sin redibujarlo.

## Qué usar en cada sitio

| Fichero | Dónde | Notas |
|---|---|---|
| `icon-192.png` · `icon-256.png` · `icon-512.png` | Icono de la notificación | Círculo negro. Se aplica solo si la app no define `default_icon_url` |
| `icon-azul-*.png` | Alternativa | Mismo icono sobre el azul de marca (`#2a78d6`) |
| `badge-96.png` · `badge-72.png` | Badge de Chrome / barra de estado | **Solo alfa**: el sistema lo tiñe |
| `android/drawable-*/ic_stat_pushflow.png` | Icono pequeño de Android | Solo alfa, cinco densidades |
| `android/mipmap-xxxhdpi/ic_launcher_foreground.png` | Icono adaptativo | Capa frontal, 108 dp con zona segura de 72 dp |
| `favicon.ico` · `favicon-32.png` | Pestaña del panel | |
| `apple-touch-icon-180.png` | iOS al añadir a la pantalla de inicio | Cuadrado pleno: iOS aplica su propia máscara |
| `logo-mark.svg` | Vector maestro | Usa `currentColor`: hereda el color del contexto |
| `logo-mark-white.svg` | Vector en blanco | Para fondos oscuros |

## Por qué el badge va solo en alfa

Android y Chrome **descartan el color** del icono pequeño y lo pintan con el
suyo, respetando únicamente el canal alfa. Si se les entrega un PNG con fondo
opaco, el resultado es un cuadrado sólido en la barra de estado. Por eso
`badge-*.png` y los `ic_stat_*` no llevan fondo.

## Proporciones

| Uso | Marca respecto al lienzo | Motivo |
|---|---|---|
| Icono circular | 72 % | Deja un margen del 17 %; a salvo si la plataforma recorta en círculo |
| Barra de estado | 88 % | Necesita el máximo tamaño para leerse a 24 px |
| Favicon | 84 % | Cuadrado, sin recorte: puede ir más grande |
| apple-touch | 66 % | iOS recorta en squircle |
| Adaptativo Android | 62 % | El aro queda dentro de la zona segura de 72 dp |

## Regenerar

Los iconos se derivaron del `.ai` (que es un PDF) con PyMuPDF y Pillow. Para
rehacerlos tras un cambio de logo, el maestro es `logo-mark.svg`: reemplázalo
y vuelve a exportar respetando la tabla de proporciones de arriba.

## Cambiar el icono por defecto del sistema

Sin tocar ficheros, apuntando a otra ruta:

```ini
# .env
DEFAULT_ICON_PATH=/brand/icon-azul-192.png
DEFAULT_BADGE_PATH=/brand/badge-96.png
```

Cada app puede además fijar el suyo en **Ajustes → Icono por defecto**, que
tiene prioridad sobre estos.

## Icono propio de una app

Desde **Ajustes → Icono por defecto** se puede subir una imagen o pegar una URL:

- **Subir imagen** acepta PNG, JPEG y WebP hasta 1 MB, entre 64×64 y 2048×2048.
  Se recomienda cuadrada y de 192×192 como mínimo. Si no es cuadrada se acepta,
  pero avisa: los sistemas recortan el icono.
- **Eliminar** quita el icono y borra el fichero del servidor; las
  notificaciones vuelven a usar el del sistema.

El formato se comprueba leyendo los bytes de la cabecera, no la extensión ni el
`content-type`: renombrar un fichero no basta para colarlo. SVG queda fuera a
propósito — un SVG puede llevar scripts y se serviría desde el dominio del
panel.

Los ficheros se guardan en `data/uploads/<app-id>/` con un nombre generado
(nunca el del cliente) y se sirven con `X-Content-Type-Options: nosniff`.
