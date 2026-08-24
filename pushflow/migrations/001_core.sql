-- PushFlow :: 001_core
-- Núcleo multi-tenant: organizaciones, apps, claves API, usuarios del panel.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Organizaciones y usuarios del panel
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  plan        text NOT NULL DEFAULT 'self-hosted',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          text NOT NULL,
  name           text,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'owner'
                 CHECK (role IN ('owner','admin','member','viewer')),
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','disabled')),
  totp_secret    text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_users_email_key ON admin_users (lower(email));

CREATE TABLE admin_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  ip          inet,
  user_agent  text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions (user_id);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Aplicaciones (equivalente a "App" de OneSignal)
-- ---------------------------------------------------------------------------
CREATE TABLE apps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  slug              text NOT NULL,

  -- Web push
  site_url          text,
  allowed_origins   text[] NOT NULL DEFAULT '{}',
  default_icon_url  text,
  vapid_public      text,
  vapid_private     text,
  vapid_subject     text,
  safari_web_id     text,

  -- Android / FCM HTTP v1
  fcm_project_id    text,
  fcm_client_email  text,
  fcm_private_key   text,          -- cifrado con APP_SECRET (AES-256-GCM)
  android_package   text,

  -- Configuración: prompt, bienvenida, quiet hours, frequency cap, etc.
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,

  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX apps_org_slug_key ON apps (org_id, slug);
CREATE INDEX apps_org_idx ON apps (org_id);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT 'default',
  key_prefix  text NOT NULL,
  key_hash    text NOT NULL,
  scopes      text[] NOT NULL DEFAULT '{notifications:write,subscriptions:write,analytics:read}',
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_prefix_key ON api_keys (key_prefix);
CREATE INDEX api_keys_app_idx ON api_keys (app_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audiencia: usuarios finales y suscripciones (dispositivos)
-- ---------------------------------------------------------------------------
CREATE TABLE end_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  external_id  text,
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags         jsonb NOT NULL DEFAULT '{}'::jsonb,
  language     text,
  country      text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX end_users_app_external_key ON end_users (app_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX end_users_app_idx ON end_users (app_id);

CREATE TABLE user_aliases (
  user_id  uuid NOT NULL REFERENCES end_users(id) ON DELETE CASCADE,
  app_id   uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  label    text NOT NULL,
  value    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, label, value)
);

CREATE TABLE subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES end_users(id) ON DELETE SET NULL,
  external_user_id  text,

  channel           text NOT NULL CHECK (channel IN ('web_push','android','ios','email','sms')),
  device_type       text,             -- chrome, firefox, safari, edge, android

  -- Web Push (RFC 8030 / 8291)
  endpoint          text,
  p256dh            text,
  auth_key          text,

  -- Android (FCM)
  fcm_token         text,

  -- Ficha del dispositivo
  device_model      text,
  device_os         text,
  os_version        text,
  browser_name      text,
  browser_version   text,
  sdk_version       text,
  app_version       text,
  language          text,
  timezone          text,
  timezone_offset   int,
  country           text,
  region            text,
  city              text,
  lat               double precision,
  lng               double precision,
  ip                inet,

  -- Estado
  subscribed        boolean NOT NULL DEFAULT true,
  opted_out         boolean NOT NULL DEFAULT false,
  invalid           boolean NOT NULL DEFAULT false,
  invalid_reason    text,
  invalidated_at    timestamptz,
  unsubscribed_at   timestamptz,
  test_type         int,               -- 1=development, 2=test-user

  -- Actividad
  session_count       int NOT NULL DEFAULT 1,
  total_duration_sec  bigint NOT NULL DEFAULT 0,
  last_session_at     timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_notification_at timestamptz,

  tags              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_endpoint_key ON subscriptions (app_id, md5(endpoint))
  WHERE endpoint IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_fcm_key ON subscriptions (app_id, fcm_token)
  WHERE fcm_token IS NOT NULL;
CREATE INDEX subscriptions_app_active_idx ON subscriptions (app_id, channel)
  WHERE subscribed AND NOT invalid AND NOT opted_out;
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);
CREATE INDEX subscriptions_external_idx ON subscriptions (app_id, external_user_id)
  WHERE external_user_id IS NOT NULL;
CREATE INDEX subscriptions_tags_idx ON subscriptions USING gin (tags jsonb_path_ops);
CREATE INDEX subscriptions_last_seen_idx ON subscriptions (app_id, last_seen_at DESC);
CREATE INDEX subscriptions_country_idx ON subscriptions (app_id, country);
CREATE INDEX subscriptions_language_idx ON subscriptions (app_id, language);
CREATE INDEX subscriptions_created_idx ON subscriptions (app_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Segmentos
-- ---------------------------------------------------------------------------
CREATE TABLE segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  filters      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_system    boolean NOT NULL DEFAULT false,
  cached_count bigint,
  cached_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX segments_app_name_key ON segments (app_id, lower(name));

-- ---------------------------------------------------------------------------
-- Plantillas
-- ---------------------------------------------------------------------------
CREATE TABLE templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX templates_app_name_key ON templates (app_id, lower(name));
