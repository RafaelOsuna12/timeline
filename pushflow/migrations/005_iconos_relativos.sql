-- PushFlow :: 005_iconos_relativos
-- Los iconos subidos se guardaban con la URL absoluta, que incluye PUBLIC_URL.
-- Al cambiar de dominio esas referencias quedarían rotas, así que se pasan a
-- ruta relativa. Las URL externas (otro dominio) se dejan intactas.

UPDATE apps
SET default_icon_url = regexp_replace(default_icon_url, '^https?://[^/]+(/uploads/)', '\1')
WHERE default_icon_url ~ '^https?://[^/]+/uploads/';
