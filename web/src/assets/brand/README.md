# Marca

Activos oficiales tal como los entregó el cliente:

- `HONOR_NewLogo_Horizontal_Black.png` — versión negra (fondo claro).
- `HONOR_NewLogo_Horizontal_White.png` — versión blanca (fondo oscuro).

Ambos PNG tienen el mismo canal alfa y solo difieren en el color, así que el
sitio no usa ninguno de los dos directamente: se vectorizó el contorno con
potrace y el resultado se pinta en `currentColor`
(`src/components/Brand.jsx`, referencia en `honor-horizontal.svg`). Así un solo
activo queda negro sobre fondo claro y blanco sobre fondo oscuro, sin decidir
en tiempo de ejecución cuál de los dos archivos cargar.

Para reemplazar la marca, sustituye los PNG y vuelve a vectorizar con el mismo
procedimiento: recortar por el `bbox` del canal alfa, trazar el negativo del
alfa (potrace invierte los datos al construir el mapa de bits) y normalizar el
`viewBox` a 100 de alto.
