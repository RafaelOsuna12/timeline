-- PushFlow :: 002_messaging
-- Notificaciones, entregas por dispositivo, cola de trabajos.

CREATE TABLE notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  template_id           uuid REFERENCES templates(id) ON DELETE SET NULL,
  automation_id         uuid,
  name                  text,

  -- Contenido localizado: {"en":"...", "es":"..."} — admite emojis (UTF-8 4 bytes)
  headings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  contents              jsonb NOT NULL DEFAULT '{}'::jsonb,
  subtitle              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Destino al pulsar
  url                   text,
  web_url               text,
  app_url               text,          -- deep link (esquema propio o App Link)
  launch_activity       text,

  -- Multimedia
  icon_url              text,
  image_url             text,          -- big picture / image
  badge_url             text,
  large_icon            text,
  buttons               jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,text,icon,url}]

  -- Opciones por plataforma
  android_channel_id    text,
  android_sound         text,
  android_accent_color  text,
  android_group         text,
  android_visibility    int,
  web_push_topic        text,
  priority              int NOT NULL DEFAULT 10,
  ttl                   int NOT NULL DEFAULT 259200,
  collapse_id           text,
  require_interaction   boolean NOT NULL DEFAULT false,
  silent                boolean NOT NULL DEFAULT false,
  vibration_pattern     int[],
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Segmentación
  target_type           text NOT NULL DEFAULT 'segments'
                        CHECK (target_type IN ('segments','filters','subscription_ids','external_ids','all')),
  included_segments     uuid[] NOT NULL DEFAULT '{}',
  excluded_segments     uuid[] NOT NULL DEFAULT '{}',
  filters               jsonb NOT NULL DEFAULT '[]'::jsonb,
  include_subscription_ids uuid[] NOT NULL DEFAULT '{}',
  include_external_ids  text[] NOT NULL DEFAULT '{}',
  channels              text[] NOT NULL DEFAULT '{web_push,android}',

  -- Programación / entrega
  send_after            timestamptz,
  delayed_option        text CHECK (delayed_option IN ('immediate','timezone','last-active')),
  delivery_time_of_day  text,           -- "09:00"
  throttle_per_minute   int,
  respect_quiet_hours   boolean NOT NULL DEFAULT true,
  respect_frequency_cap boolean NOT NULL DEFAULT true,

  -- A/B testing: {"variants":[{"id":"A","weight":50,"headings":{},"contents":{}}], "winner":"A"}
  ab_test               jsonb,

  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','scheduled','queued','sending','sent','canceled','failed')),
  queued_at             timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  canceled_at           timestamptz,
  error_message         text,

  -- Contadores desnormalizados
  recipients            bigint NOT NULL DEFAULT 0,
  successful            bigint NOT NULL DEFAULT 0,
  failed                bigint NOT NULL DEFAULT 0,
  errored               bigint NOT NULL DEFAULT 0,
  received              bigint NOT NULL DEFAULT 0,
  clicked               bigint NOT NULL DEFAULT 0,
  dismissed             bigint NOT NULL DEFAULT 0,
  converted             bigint NOT NULL DEFAULT 0,

  idempotency_key       text,
  created_by            uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  source                text NOT NULL DEFAULT 'api',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_app_created_idx ON notifications (app_id, created_at DESC);
CREATE INDEX notifications_status_idx ON notifications (status, send_after)
  WHERE status IN ('scheduled','queued','sending');
CREATE UNIQUE INDEX notifications_idempotency_key ON notifications (app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Entregas por dispositivo (particionada por mes)
-- ---------------------------------------------------------------------------
CREATE TABLE deliveries (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  notification_id  uuid NOT NULL,
  app_id           uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  user_id          uuid,
  channel          text NOT NULL,
  variant          text,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','delivered','failed','clicked','dismissed','skipped')),
  provider_id      text,
  error_code       text,
  error_message    text,
  sent_at          timestamptz,
  delivered_at     timestamptz,
  clicked_at       timestamptz,
  dismissed_at     timestamptz,
  action_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

CREATE INDEX deliveries_notification_idx ON deliveries (notification_id, status);
CREATE INDEX deliveries_subscription_idx ON deliveries (subscription_id, created_at DESC);
CREATE INDEX deliveries_app_idx ON deliveries (app_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Eventos analíticos crudos (particionada por mes)
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  app_id           uuid NOT NULL,
  subscription_id  uuid,
  user_id          uuid,
  notification_id  uuid,
  type             text NOT NULL,     -- displayed|clicked|dismissed|session_start|session_end|
                                      -- subscribed|unsubscribed|outcome|action_click|permission_prompt
  name             text,              -- nombre del outcome / acción
  value            numeric,
  channel          text,
  device_type      text,
  browser_name     text,
  os               text,
  country          text,
  city             text,
  language         text,
  url              text,
  action_id        text,
  properties       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

CREATE INDEX events_app_type_idx ON events (app_id, type, created_at DESC);
CREATE INDEX events_notification_idx ON events (notification_id, type);
CREATE INDEX events_subscription_idx ON events (subscription_id, created_at DESC);
CREATE INDEX events_name_idx ON events (app_id, name) WHERE name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Gestión automática de particiones mensuales
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pushflow_ensure_partitions(months_ahead int DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  tbl      text;
  i        int;
  start_ts date;
  end_ts   date;
  part     text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['deliveries','events'] LOOP
    FOR i IN -1..months_ahead LOOP
      start_ts := date_trunc('month', now())::date + (i || ' month')::interval;
      end_ts   := start_ts + interval '1 month';
      part     := format('%s_p%s', tbl, to_char(start_ts, 'YYYYMM'));
      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          part, tbl, start_ts, end_ts);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- Elimina particiones más antiguas que el periodo de retención.
CREATE OR REPLACE FUNCTION pushflow_drop_old_partitions(retention_months int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  r       record;
  cutoff  date := (date_trunc('month', now()) - (retention_months || ' month')::interval)::date;
  dropped int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname IN ('deliveries','events')
  LOOP
    IF to_date(right(r.relname, 6), 'YYYYMM') < cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END;
$$;

SELECT pushflow_ensure_partitions(3);

-- ---------------------------------------------------------------------------
-- Cola de trabajos (sin Redis: SELECT ... FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id       uuid,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority     int NOT NULL DEFAULT 100,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','done','failed','canceled')),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  unique_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (priority, run_at, id) WHERE status = 'pending';
CREATE INDEX jobs_type_idx ON jobs (type, status);
CREATE UNIQUE INDEX jobs_unique_key_idx ON jobs (unique_key)
  WHERE unique_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX jobs_cleanup_idx ON jobs (status, updated_at);

-- ---------------------------------------------------------------------------
-- Límite de frecuencia por suscripción
-- ---------------------------------------------------------------------------
CREATE TABLE subscription_counters (
  subscription_id  uuid PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  app_id           uuid NOT NULL,
  day              date NOT NULL DEFAULT current_date,
  sent_today       int NOT NULL DEFAULT 0,
  sent_total       bigint NOT NULL DEFAULT 0,
  last_sent_at     timestamptz
);
CREATE INDEX subscription_counters_app_idx ON subscription_counters (app_id, day);
