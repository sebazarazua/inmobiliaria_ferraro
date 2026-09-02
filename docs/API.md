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
