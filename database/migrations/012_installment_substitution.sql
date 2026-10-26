ALTER TABLE installments DROP CONSTRAINT IF EXISTS installments_status_check;
ALTER TABLE installments
  ADD CONSTRAINT installments_status_check CHECK(status IN ('Pendiente','Pagado','Parcial','Vencido','Sustituido'));

-- Renovaciones previas: las cuotas del contrato renovado que caen dentro de la vigencia
-- del contrato nuevo y no tienen pagos quedan sustituidas para no duplicar cobros.
UPDATE installments i
SET status = 'Sustituido'
FROM contracts old
JOIN contracts nxt ON nxt.previous_contract_id = old.id
WHERE i.contract_id = old.id
  AND old.status = 'Renovado'
  AND i.period >= to_char(nxt.start_date, 'YYYY-MM')
  AND i.status IN ('Pendiente','Vencido')
  AND i.manual_partial_amount = 0
  AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.installment_id = i.id);
