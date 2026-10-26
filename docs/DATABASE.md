# Base de datos

PostgreSQL 17 se ejecuta con Docker Compose. `backend/src/database/index.js` administra un pool de conexiones y aplica en orden las migraciones de `database/migrations/`.

Los importes usan `numeric(14,2)`, las fechas tipos `date/timestamptz`, los identificadores son UUID y los metadatos variables se almacenan como `jsonb`. Hay índices para vencimientos, contratos, pagos, incidencias, movimientos e importaciones.

## Núcleo

- `persons`: personas físicas o jurídicas, deduplicadas por documento.
- `properties`: inmuebles, deduplicados por dirección normalizada.
- `property_owners`: relación muchos-a-muchos entre inmuebles y titulares.
- `contracts`: condiciones económicas y vigencia del alquiler.
- `contract_owners`: titulares que intervienen en cada contrato.
- `guarantees`: seguro de caución, garantía propietaria u otro respaldo.

## Operación

- `installments`: cuotas mensuales proyectadas. El estado `Sustituido` marca cuotas de un contrato renovado que quedaron cubiertas por el contrato nuevo; se conservan como historial y no se cobran.
- `payments`: transferencias aplicadas a una cuota.
- `incidents`: incidencias vinculables a propiedad y contrato.
- `ledger_entries`: ingresos y gastos generales o vinculados.

## Documentos y control

- `documents`: PDF original, ruta, hash y texto extraído.
- `imports`: resultado, confianza, advertencias y errores de cada lectura.
- `settings`: configuración operativa editable.
- `audit_log`: acciones relevantes para trazabilidad.

No se eliminan documentos al actualizar entidades. La huella SHA-256 impide importar dos veces el mismo archivo.
