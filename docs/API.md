# API actual

Todas las respuestas son JSON y los errores usan `{ "error": "mensaje" }`.

## Sistema

- `GET /api/health`
- `GET /api/dashboard`
- `GET|PUT /api/settings`

## Administración

- `GET|POST /api/properties`
- `GET|POST /api/people`
- `GET|POST /api/contracts`
- `PATCH /api/contracts/:id`
- `GET /api/contracts/:id/renewal-candidates`: contratos importados con PDF propio que pueden vincularse como renovación (misma propiedad, vigentes, sin contrato anterior, que comienzan después del actual).
- `POST /api/contracts/:id/renew` con `{ "new_contract_id": "..." }`: vincula el contrato nuevo (`previous_contract_id`), lo deja `Activo`, pasa el anterior a `Renovado` y marca como `Sustituido` sus cuotas futuras sin pagos. No crea ni copia contratos.
- `GET /api/owners`: incluye `properties_count`, `property_ids` y `properties_list` (`id`, `code`, `address`).
- `GET /api/pending-collections`: cada cuota incluye `period` (`YYYY-MM`), que usa el filtro por mes.
- `GET /api/collections`
- `POST /api/payments/:installmentId/register`
- `GET|POST /api/incidents`
- `PATCH /api/incidents/:id`
- `GET|POST /api/ledger`

## Documentos

- `GET /api/documents`
- `GET /api/imports`
- `POST /api/imports/scan`

La API mantiene por ahora los contratos que consume el frontend existente. Las nuevas versiones deben conservar estas rutas o introducir versionado antes de romperlas.

## IPC y conciliación

- `GET /api/ipc/latest`: lee exclusivamente PostgreSQL. Incluye `latestPeriod`, `latestIndex`, `latestVariation` (fracción decimal), fuente, URL, últimas consultas y errores.
- `POST /api/ipc/refresh` con `{}`: consulta fuentes oficiales y actualiza las cuotas ya incorporadas al motor. Control compartido de concurrencia y espera mínima manual de 60 segundos. Nunca incorpora automáticamente cuotas anteriores a la migración.
- `POST /api/ipc/preview`: recibe `start_date`, `duration_months`, `initial_amount`, `adjustment_index`, `adjustment_frequency_months`, `ipc_lag_months` y `currency`. Devuelve el cronograma completo usando índices almacenados, sin escrituras.
- `POST /api/ipc/reconciliation/simulate` con `{ "contract_id": "uuid opcional" }`: incluye cuotas históricas, pagadas y futuras; no modifica registros. Devuelve `token`, `rows`, `blocked`, conteos y totales por moneda, incluyendo saldos negativos/sobrepagos.
- El mismo endpoint acepta `contract_changes` para simular nuevas condiciones. Los cambios se evalúan en una transacción que se revierte, sin alterar el contrato.
- `POST /api/ipc/reconciliation/apply`: requiere el mismo alcance (`contract_id`), `token` vigente, `reason` e `interpretation_confirmed: true` para incorporar cuotas anteriores. Ante cambios de pagos, condiciones o índices relevantes debe repetirse la simulación. Las cuotas bloqueadas impiden aplicar el lote.
- `GET /api/contracts/:id/adjustments`: historial de versiones con importes anteriores/nuevos, razón, referencias, coeficientes, fuentes y fechas.
- `PATCH /api/contracts/:id`: si cambian condiciones económicas IPC, requiere `reconciliation_token` obtenido simulando esas condiciones e `interpretation_confirmed: true`. La actualización del contrato, cuotas y auditoría es transaccional. `ipc_clause_confirmed: true` permite resolver una cláusula revisada.

`GET /api/pending-collections` utiliza `expected_amount` persistido. Incluye `contractual_amount`, `original_expected_amount`, `rent_override_amount`, `calculation_json`, `adjustment_pending`, `ipc_requires_reconciliation`, `balance` y `overpayment_amount`. Dashboard lee los mismos importes persistidos. Las cuotas pagadas provisionales siguen visibles en pendientes.

El registro de pagos no descarga IPC ni recalcula el canon. Una transferencia no elimina `adjustment_pending`; si falta información, el estado sigue siendo `Parcial` y la cuota puede tener saldo provisional cero.

## Ciclo de vida, eliminación segura y documentos (migración 014)

Contratos:
- `GET /api/contracts/:id/lifecycle` — estado actual, acciones permitidas (con motivo cuando no lo están) e historial de auditoría.
- `POST /api/contracts/:id/{deactivate|reactivate|finalize|archive|restore|void|rescind}` — transiciones validadas en backend; repetir una solicitud ya aplicada devuelve `unchanged: true`.
- `GET /api/contracts/:id/impact` — vista previa: `blockers`, `remove`, `unlink`, `keep`, `irreversible`, `alternatives`.
- `DELETE /api/contracts/:id` con `{ "confirm": true }` — solo si no hay cobros, pagos parciales, movimientos contables ni renovaciones vinculadas. Los PDF y documentos se desvinculan, nunca se borran.

Propiedades y personas (`properties`, `owners`, `tenants`, `people`):
- `GET /api/:recurso/:id/impact`, `POST /api/:recurso/:id/archive|restore`, `DELETE /api/:recurso/:id` con `{ "confirm": true }`.

Documentos (`/api/document-admin`):
- `GET /api/document-admin` — cada PDF (carpeta + registros) con `state`, `reason`, `actions`, `blocked` e `history`.
- `GET /api/document-admin/file?import_id=|document_id=|file=` — muestra el PDF (solo dentro de la carpeta administrada).
- `POST /api/document-admin/{reprocess|exclude|unexclude|delete-record|delete-file}` con `{ "ref": {...} }`; `delete-record` y `delete-file` exigen `confirm: true`. La referencia es un id o un nombre de archivo sin rutas; nunca una ruta.
