/**
 * Enlaces que conservan el corte que se esta viendo.
 *
 * Los filtros —incluido el periodo— viven en la query string. Un enlace que la
 * pierda manda al usuario al snapshot mas reciente: al abrir la ficha de un
 * promotor desde el mes pasado, aparecian los datos del mes en curso.
 */
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Devuelve una funcion que añade la query string actual a una ruta. */
export function useFilteredLink() {
  const { search } = useLocation();
  return useCallback((path) => `${path}${search}`, [search]);
}

/** Igual que `navigate`, pero conservando los filtros activos. */
export function useFilteredNavigate() {
  const navigate = useNavigate();
  const link = useFilteredLink();
  return useCallback((path, options) => navigate(link(path), options), [navigate, link]);
}

/** Ruta a la ficha de un promotor. */
export function promoterPath(key) {
  return `/promotores/${encodeURIComponent(key)}`;
}
