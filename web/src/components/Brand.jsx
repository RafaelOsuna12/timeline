/**
 * Marca HONOR.
 *
 * Un solo trazado en `currentColor`, de modo que el mismo archivo sirve en la
 * barra lateral oscura y en la tarjeta de acceso clara sin duplicar el activo:
 * el color lo pone quien lo contiene. `Mark` es solo el anillo, para los
 * espacios donde no cabe la palabra.
 */

const RING =
  'M221.1,2.9 A240,240 0 0 1 324.1,467.5 L227.4,381.2 A140,140 0 0 0 292.2,111.3 Z ' +
  'M262.9,481.1 A240,240 0 0 1 159.9,16.5 L256.6,102.8 A140,140 0 0 0 191.8,372.7 Z';

const WORD =
  'M600,120 h40 v245 h-40 Z M760,120 h40 v245 h-40 Z M640,222.5 h120 v40 h-120 Z ' +
  'M858,242.5 A124,122.5 0 1 1 1106,242.5 A124,122.5 0 1 1 858,242.5 Z ' +
  'M898,242.5 A84,82.5 0 1 0 1066,242.5 A84,82.5 0 1 0 898,242.5 Z ' +
  'M1164,120 h40 v245 h-40 Z M1332,120 h40 v245 h-40 Z M1164,120 L1204,120 L1372,365 L1332,365 Z ' +
  'M1430,242.5 A124,122.5 0 1 1 1678,242.5 A124,122.5 0 1 1 1430,242.5 Z ' +
  'M1470,242.5 A84,82.5 0 1 0 1638,242.5 A84,82.5 0 1 0 1470,242.5 Z ' +
  'M1736,120 L1855,120 A67,67 0 0 1 1855,254 L1736,254 Z ' +
  'M1776,214 L1855,214 A27,27 0 0 0 1855,160 L1776,160 Z ' +
  'M1736,120 h40 v245 h-40 Z M1842,214 L1882,214 L1934,365 L1894,365 Z';

export function Brand({ height = 22, className, title = 'HONOR' }) {
  return (
    <svg
      viewBox="0 0 1944 485"
      height={height}
      width={height * (1944 / 485)}
      fill="currentColor"
      className={className}
      role="img"
      aria-label={title}
    >
      <path d={RING} />
      <path d={WORD} />
    </svg>
  );
}

export function BrandMark({ size = 24, className, title = 'HONOR' }) {
  return (
    <svg viewBox="0 0 485 485" height={size} width={size} fill="currentColor" className={className} role="img" aria-label={title}>
      <path d={RING} transform="translate(0.5 0)" />
    </svg>
  );
}

export default Brand;
