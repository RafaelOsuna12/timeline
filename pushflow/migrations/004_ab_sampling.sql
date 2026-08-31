-- PushFlow :: 004_ab_sampling
-- Muestreo del test A/B y exclusión de quien ya recibió el mensaje.

-- Porcentaje de la audiencia que participa en el test (el resto recibe la
-- variante ganadora al cerrarlo). NULL o 100 = participa toda la audiencia.
ALTER TABLE notifications
  ADD COLUMN sample_percent int
    CHECK (sample_percent IS NULL OR (sample_percent > 0 AND sample_percent <= 100));

-- Al enviar la ganadora de un test A/B, se excluye a quien ya recibió alguna
-- de las variantes para no duplicar el mensaje.
ALTER TABLE notifications
  ADD COLUMN exclude_delivered_for uuid REFERENCES notifications(id) ON DELETE SET NULL;
