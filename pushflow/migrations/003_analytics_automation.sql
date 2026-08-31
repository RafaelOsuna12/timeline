-- PushFlow :: 003_analytics_automation
-- Agregados de analítica, outcomes, webhooks, automatizaciones, mensajes in-app.

-- ---------------------------------------------------------------------------
-- Agregados diarios por app / canal
-- ---------------------------------------------------------------------------
CREATE TABLE daily_stats (
  app_id        uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  day           date NOT NULL,
  channel       text NOT NULL,
  subs_added    bigint NOT NULL DEFAULT 0,
  subs_removed  bigint NOT NULL DEFAULT 0,
  sent          bigint NOT NULL DEFAULT 0,
  delivered     bigint NOT NULL DEFAULT 0,
  clicked       bigint NOT NULL DEFAULT 0,
  dismissed     bigint NOT NULL DEFAULT 0,
  failed        bigint NOT NULL DEFAULT 0,
  sessions      bigint NOT NULL DEFAULT 0,
  outcomes      bigint NOT NULL DEFAULT 0,
  outcome_value numeric NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, day, channel)
);

-- Serie temporal por notificación (para el gráfico de "primeras 24 h")
CREATE TABLE notification_stats_hourly (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  hour            timestamptz NOT NULL,
  sent            bigint NOT NULL DEFAULT 0,
  delivered       bigint NOT NULL DEFAULT 0,
  clicked         bigint NOT NULL DEFAULT 0,
  dismissed       bigint NOT NULL DEFAULT 0,
  failed          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (notification_id, hour)
);

-- ---------------------------------------------------------------------------
-- Outcomes (conversiones) — equivalente a "Outcomes" de OneSignal
-- ---------------------------------------------------------------------------
CREATE TABLE outcomes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                   uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  kind                     text NOT NULL DEFAULT 'count' CHECK (kind IN ('count','sum','unique')),
  attribution_window_min   int NOT NULL DEFAULT 1440,   -- ventana de atribución directa/influenciada
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outcomes_app_name_key ON outcomes (app_id, lower(name));

CREATE TABLE outcome_attributions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id          uuid NOT NULL,
  outcome_id      uuid REFERENCES outcomes(id) ON DELETE CASCADE,
  name            text NOT NULL,
  notification_id uuid,
  subscription_id uuid,
  attribution     text NOT NULL CHECK (attribution IN ('direct','influenced','unattributed')),
  value           numeric NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outcome_attr_app_idx ON outcome_attributions (app_id, name, created_at DESC);
CREATE INDEX outcome_attr_notification_idx ON outcome_attributions (notification_id);

-- ---------------------------------------------------------------------------
-- Webhooks salientes
-- ---------------------------------------------------------------------------
CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  url         text NOT NULL,
  events      text[] NOT NULL DEFAULT '{notification.sent,notification.clicked,subscription.created}',
  secret      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  status_code int,
  error       text,
  attempts    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Automatizaciones / journeys
-- ---------------------------------------------------------------------------
CREATE TABLE automations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- trigger: {"type":"subscription_created"|"event"|"tag_changed"|"inactivity"|"schedule",
  --           "event_name":"cart_abandoned","cron":"0 9 * * *","inactive_days":7}
  trigger      jsonb NOT NULL,
  -- steps: [{"type":"wait","minutes":60},{"type":"send","payload":{...}},
  --         {"type":"condition","filters":[...]}]
  steps        jsonb NOT NULL DEFAULT '[]'::jsonb,
  segment_id   uuid REFERENCES segments(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused','archived')),
  reentry      boolean NOT NULL DEFAULT false,
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_app_idx ON automations (app_id, status);

CREATE TABLE automation_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  app_id          uuid NOT NULL,
  subscription_id uuid NOT NULL,
  step_index      int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','completed','canceled','failed')),
  next_run_at     timestamptz,
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_runs_due_idx ON automation_runs (next_run_at) WHERE status = 'active';
CREATE UNIQUE INDEX automation_runs_active_key
  ON automation_runs (automation_id, subscription_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Mensajes in-app (se entregan al abrir la web/app, sin permiso del navegador)
-- ---------------------------------------------------------------------------
CREATE TABLE in_app_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name         text NOT NULL,
  layout       text NOT NULL DEFAULT 'modal' CHECK (layout IN ('modal','banner_top','banner_bottom','fullscreen')),
  content      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {title, body, image, buttons:[{text,url,action}]}
  triggers     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"type":"session_count","operator":">=","value":3}]
  filters      jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_displays int NOT NULL DEFAULT 1,
  start_at     timestamptz,
  end_at       timestamptz,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX in_app_messages_app_idx ON in_app_messages (app_id, status);

CREATE TABLE in_app_impressions (
  message_id      uuid NOT NULL REFERENCES in_app_messages(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL,
  displays        int NOT NULL DEFAULT 0,
  clicks          int NOT NULL DEFAULT 0,
  last_display_at timestamptz,
  PRIMARY KEY (message_id, subscription_id)
);

-- ---------------------------------------------------------------------------
-- Exportaciones y auditoría
-- ---------------------------------------------------------------------------
CREATE TABLE exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('subscriptions','notifications','events','deliveries')),
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  file_path   text,
  rows        bigint,
  error       text,
  created_by  uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid,
  app_id      uuid,
  user_id     uuid,
  action      text NOT NULL,
  target      text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, created_at DESC);
