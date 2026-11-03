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

## IPC y trazabilidad — migración 013

- `ipc_index_versions`: niveles oficiales `numeric(24,10)`, variación mensual decimal, período, fuente, URL, fecha de consulta y huella del contenido. Conserva revisiones previas.
- `ipc_indices`: período único y referencia a su versión vigente.
- `ipc_refresh_state`: última consulta intentada/válida, fuente, último período y error. Evita depender de una caché volátil.
- `contracts.ipc_clause_text`: texto original extraído. `ipc_clause_review_required` impide aplicar reglas ambiguas sin revisión.
- `installments.ipc_managed`: incorporación al motor; por defecto `false` para proteger las cuotas existentes.
- `contractual_amount`: canon reconstruido por el motor, independiente de bonificaciones y correcciones manuales.
- `expected_amount`: alquiler efectivo que leen todos los consumidores.
- `original_expected_amount`: conserva el importe previo a la primera conciliación/edición, o el importe inicialmente generado por esta versión.
- `rent_override_amount`: importe manual explícito que las actualizaciones IPC respetan.
- `calculation_json` y `calculation_hash`: cálculo vigente y huella idempotente.
- `rent_adjustment_history`: versiones sucesivas por cuota, importes anteriores/nuevos, motivo y cálculo completo. Los identificadores de auditoría sobreviven a eliminaciones para conservar la explicación histórica.

La migración 013 no recalcula cuotas, cambia pagos ni incorpora registros existentes al motor. El alta, la importación y la aplicación de una conciliación generan la trazabilidad dentro de sus transacciones.

Los locks de actualización de índices, generación y conciliación comparten una clave transaccional. El acceso a Internet usa un lock de consulta separado, sin bloquear filas financieras durante la descarga. Los pagos bloquean contrato/cuota y se registran junto con su estado en una transacción.

## Migración 014 — ciclo de vida de contratos, entidades y documentos

Aditiva. Agrega el estado `Desactivado` a contratos, `deactivated_from_status` y `archived_from_status` (estado a restaurar), `finalized_at`, `archived_at` en `properties` y `persons`, `imports.previous_import_id` (trazabilidad entre intentos) y la tabla `import_exclusions` (hashes que el scanner nunca importa). No modifica filas existentes. El scanner ya no borra datos cuando falta un PDF: solo lo informa.
