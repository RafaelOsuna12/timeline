/**
 * Envoltura de la barra de filtros.
 *
 * En escritorio no hace nada: los filtros se ven siempre, como hasta ahora.
 *
 * En telefono si. La barra lleva seis campos y, apilados, ocupaban casi toda
 * la pantalla; como el encabezado va fijo, se quedaban pegados y no dejaban
 * navegar. Aqui se pliegan detras de un boton.
 *
 * Las pastillas de los filtros activos quedan FUERA de esta envoltura a
 * proposito: plegar los controles no debe esconder que hay un filtro puesto,
 * porque entonces alguien lee un numero creyendo que es el total. Por eso el
 * boton ademas trae la cuenta.
 */
import { useState } from 'react';

const Chevron = ({ abierto }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ transform: abierto ? 'rotate(180deg)' : 'none', transition: 'transform 0.18s ease' }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export function FilterPanel({ active = 0, children }) {
  const [abierto, setAbierto] = useState(false);

  return (
    <div className={`filterpanel${abierto ? ' is-open' : ''}`}>
      <button
        type="button"
        className="filterpanel__toggle no-print"
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
      >
        <span>Filtros</span>
        {active > 0 && <span className="filterpanel__count">{active}</span>}
        <Chevron abierto={abierto} />
      </button>
      <div className="filterpanel__body">{children}</div>
    </div>
  );
}

export default FilterPanel;
