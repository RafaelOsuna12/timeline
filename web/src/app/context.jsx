/**
 * Estado global: sesion, snapshot activo y filtros.
 *
 * Los filtros viven en la URL (query string) para que cualquier vista del
 * tablero se pueda compartir por enlace tal cual se esta viendo.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, session, setUnauthorizedHandler } from '../api.js';

const AuthContext = createContext(null);
const DataContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => session.user);
  const [checking, setChecking] = useState(Boolean(session.token));

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!session.token) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await api.login(username, password);
    session.save(res.token, res.user);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(() => {
    session.clear();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, checking, login, logout }), [user, checking, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}

const FILTER_KEYS = ['region', 'cm', 'supervisor', 'channel', 'store', 'status', 'search', 'asOfDay', 'snapshot'];

export function DataProvider({ children }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [catalog, setCatalog] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState(null);
  const reloadRef = useRef(0);

  const filters = useMemo(() => {
    const out = {};
    for (const k of FILTER_KEYS) {
      const v = searchParams.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [searchParams]);

  const setFilter = useCallback(
    (key, value) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === undefined || value === null || value === '') next.delete(key);
          else next.set(key, String(value));
          // Cambiar de region invalida las selecciones dependientes.
          if (key === 'region') {
            next.delete('cm');
            next.delete('supervisor');
            next.delete('store');
          }
          if (key === 'cm') {
            next.delete('supervisor');
            next.delete('store');
          }
          if (key === 'supervisor') next.delete('store');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const clearFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams();
        const snapshot = prev.get('snapshot');
        if (snapshot) next.set('snapshot', snapshot);
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const refresh = useCallback(() => {
    reloadRef.current += 1;
    setLoadingCatalog(true);
    Promise.all([api.snapshots(), api.filters(filters.snapshot ? { snapshot: filters.snapshot } : {})])
      .then(([s, f]) => {
        setSnapshots(s.snapshots);
        setCatalog(f);
        setCatalogError(null);
      })
      .catch((e) => setCatalogError(e))
      .finally(() => setLoadingCatalog(false));
  }, [filters.snapshot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeSnapshot = useMemo(() => {
    if (!snapshots.length) return null;
    if (filters.snapshot) return snapshots.find((s) => String(s.id) === String(filters.snapshot)) || snapshots[0];
    return snapshots[0];
  }, [snapshots, filters.snapshot]);

  const value = useMemo(
    () => ({
      filters,
      setFilter,
      clearFilters,
      catalog,
      snapshots,
      activeSnapshot,
      loadingCatalog,
      catalogError,
      refresh,
      hasData: snapshots.length > 0,
    }),
    [filters, setFilter, clearFilters, catalog, snapshots, activeSnapshot, loadingCatalog, catalogError, refresh]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData debe usarse dentro de DataProvider');
  return ctx;
}

/**
 * Hook de carga de una vista. Mantiene el render anterior mientras refresca
 * (sin parpadeo de esqueleto) y cancela peticiones obsoletas.
 */
export function useQuery(fetcher, deps, { skip = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !skip });
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    if (skip) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setState((prev) => (prev.data ? prev : { ...prev, loading: true }));
    setRefreshing(true);
    fetcher(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        setState({ data: null, error, loading: false });
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
    // `skip` entra en las dependencias: cuando el catalogo termina de cargar y
    // la vista deja de estar bloqueada, la peticion debe dispararse sola.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, skip]);

  return { ...state, refreshing };
}
