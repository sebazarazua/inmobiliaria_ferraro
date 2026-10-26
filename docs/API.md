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
