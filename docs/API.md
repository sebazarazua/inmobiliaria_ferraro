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
- `PATCH /api/contracts/:id`: edición administrativa de `alias` y `administrative_note`; no permite alterar condiciones contractuales.
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
- El mismo endpoint acepta `contract_changes` para simular nuevas condiciones. Los cambios se evalúan en una transacción que se revierte, sin alterar el contrato. Esta simulación de lectura no autoriza guardar cambios contractuales ni sustituye la rectificación documentada.
- `POST /api/ipc/reconciliation/apply`: requiere el mismo alcance (`contract_id`), `token` vigente, `reason` e `interpretation_confirmed: true` para incorporar cuotas anteriores. Ante cambios de pagos, condiciones o índices relevantes debe repetirse la simulación. Las cuotas bloqueadas impiden aplicar el lote.
- `GET /api/contracts/:id/adjustments`: historial de versiones con importes anteriores/nuevos, razón, referencias, coeficientes, fuentes y fechas.
- `PATCH /api/contracts/:id`: las condiciones contractuales están protegidas. Un `reconciliation_token`, `confirmed` o `ipc_clause_confirmed` del cliente no autoriza cambiarlas. Los valores equivalentes de clientes anteriores pueden acompañar una edición administrativa, pero no se reescriben. La rectificación utiliza las rutas documentales siguientes.

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

## Protección y rectificación documental

- `GET /api/contracts/:id/protection`: condiciones, documento original asociado y disponibilidad, nota administrativa e historial de rectificaciones.
- `POST /api/contracts/:id/rectification/simulate`: requiere `operation: "original_document_correction"`, `document_id` original, `reason` (mínimo 10 caracteres), `document_reference`, `document_quote` y `changes`. Verifica el PDF administrado y su SHA-256, la cita y el respaldo explícito de los valores propuestos. Devuelve comparación, cuotas, bloqueos y un token propio firmado que vence a los 30 minutos. No confirma cambios.
- `POST /api/contracts/:id/rectification/apply`: mismo contenido, token de esa simulación y `confirm: true`. Vuelve a verificar evidencia y estado financiero; aplica solo un impacto no bloqueado y registra actor local, fecha, versión, evidencia y valores anteriores en `audit_log`. Conserva pagos y movimientos. No acepta tokens del flujo anterior como autorización.
- La rectificación automática queda limitada a condiciones IPC que puede simular el motor existente. Moneda, vigencia, cronograma, vencimientos, punitorios, partes y otros impactos no implementados quedan bloqueados; nunca se acepta una adenda como corrección de carga.
- `PUT` de contratos no está habilitado. Las renovaciones y las acciones de estado mantienen sus operaciones específicas.

## Cargos de servicios por cuota (migración 015)

Los endpoints `/api/services` siguen registrando **gastos** en el libro contable; no crean deuda del inquilino. No se convierten los `recurring_charges` importados ni gastos históricos. Los cargos exigibles se confirman por separado.

- `GET /api/contracts/:id/services`: contrato, cuotas con totales autoritativos, cargos individuales, reglas recurrentes e historial. Incluye también cuotas pagadas para revisar una obligación posterior al cobro. Lectura con snapshot consistente.
- `POST /api/contracts/:id/services/simulate`: valida una propuesta y devuelve comparación por cargo, impacto por cuota y token firmado. No persiste cambios.
- `POST /api/contracts/:id/services/apply`: misma propuesta, `token` y `confirm: true`. Verifica nuevamente datos y evidencia declarada; aplica en una transacción y registra auditoría. Un pago o modificación intermedio invalida la simulación.

Ejemplo de propuesta de cargo único:

```json
{
  "request_id": "<UUID nuevo por operación; reutilizar en reintentos>",
  "operation": "create",
  "installment_id": "<UUID de cuota del contrato de la ruta>",
  "category": "Expensas",
  "description": "Expensas ordinarias de mayo",
  "original_amount": "25000.00",
  "currency": "ARS",
  "status": "Confirmado",
  "responsibility_confirmed": true,
  "responsibility_reference": "Cláusula 8: expensas ordinarias a cargo del inquilino",
  "reference": "Comprobante 123 / mayo 2026",
  "reason": "Cargo verificado contra comprobante",
  "scope": "single"
}
```

Los importes admiten hasta dos decimales, no negativos. La moneda debe coincidir con cuota y contrato; se admiten ARS y USD. `Borrador` admite `original_amount: null` y no suma al saldo. `Confirmado` exige importe, confirmación de responsabilidad y referencia contractual de al menos cinco caracteres. Esa referencia es una declaración auditada del operador; no es una validación jurídica automática del PDF.

Operaciones adicionales, siempre con motivo, UUID, simulación y confirmación:

| `operation` | Datos particulares |
| --- | --- |
| `edit` | `service_id` y valores completos del cargo. No reasigna la cuota; conserva condonación anterior y exige restaurarla por separado si supera el nuevo importe. |
| `forgive` | `service_id`, `forgiven_amount`: importe total condonado del cargo, reemplaza el anterior; debe ser positivo y no superar el original. |
| `restore` | `service_id`: restablece a cero su condonación, conservando historial. |
| `void` | `service_id`: anulación lógica, sin borrar pagos ni auditoría. |
| `create` con `scope: range` | `start_period`, `end_period` (`YYYY-MM`), `mode: fixed` o `variable`. Crea regla y un cargo por cuota existente del rango. |
| `create` con `scope: future` | Desde la cuota elegida hasta el final del contrato; también requiere `mode`. |
| `generate` | `rule_id`, `installment_id`, alcance/rango y confirmación de responsabilidad: genera únicamente períodos faltantes de esa regla. No duplica cargos existentes ni reactiva los anulados. |

`fixed` conserva el importe configurado; el estado propuesto determina si se confirma o se guarda borrador. `variable` guarda importe nulo y borrador en cada período, incluso si el cliente envía un importe: se completa y confirma cada mes mediante `edit`. No hay generación automática indefinida, herencia de renovaciones ni cambios masivos de importes ya emitidos.

`expense_id` opcional vincula un gasto de servicio de la misma propiedad y moneda, y del mismo contrato si el gasto tiene uno. No crea otro movimiento contable. `reference` y `notes` son opcionales. Contrato y propiedad se derivan de la cuota.

Los tokens expiran a los 15 minutos y pertenecen al proceso servidor que los emitió. `request_id` es persistente: repetir una aplicación idéntica devuelve el resultado anterior con `replayed: true`; reutilizarlo para otra propuesta se rechaza. No se aceptan tokens de conciliación IPC o de rectificación contractual.

`services_amount` en las cuotas es una proyección SQL de cargos confirmados menos sus condonaciones, actualizada por trigger. No es editable por PATCH de cobros. `balance()` la suma al importe exigible, manteniendo `payments + manual_partial_amount` como pagos computados una sola vez. `due_amount` es el saldo positivo y `overpayment_amount` conserva el crédito; no se asigna ese crédito a otra cuota automáticamente. No hay una nueva base IPC ni recálculo porcentual de descuentos: se mantiene el descuento general ya registrado.

Una cuota pagada puede reabrirse mediante la operación confirmada y auditada. Los períodos con `financial_closed_at` o estado `Sustituido` bloquean cambios de cargos. El marcador de cierre también impide nuevos pagos, edición de importes y conciliación IPC; no se expone un bypass ni se implementa una pantalla de cierre/reapertura contable. Los contratos inactivos/finalizados/renovados no generan nuevos cargos; sí conservan su consulta y admiten reducciones auditadas de cargos históricos.

Los pagos individuales y distribuidos admiten `request_id` opcional para compatibilidad con clientes antiguos; la interfaz nueva siempre lo envía. Una distribución es transaccional, usa el saldo con servicios, mantiene la moneda del contrato y revierte todas sus imputaciones si alguna falla. Los reintentos con la misma clave no duplican dinero recibido. Clientes antiguos sin clave conservan su comportamiento previo y deben evitar reenvíos ciegos.

Dashboard presenta total exigible y cobrado por moneda; sus indicadores y gráfico principales son ARS, con USD informado por separado. Pendientes, liquidación, simulación y pagos usan el mismo saldo del backend. El historial de cobros sigue mostrando transferencias efectivamente recibidas, sin convertir cargos devengados en nuevos ingresos.

## Punitorios contractuales y créditos explícitos (016)

El saldo continúa usando `late_fee_amount` como importe neto autoritativo. Se separan importe calculado/registrado (`late_fee_calculated_amount`), condonación absoluta (`late_fee_forgiven_amount`) y cálculo conservado (`late_fee_calculation_json`). La migración no reconstruye ni cambia importes históricos.

- `GET /api/contracts/:id/late-fees`: condiciones originales, última revisión, cuotas con saldo, historial de versiones y cobertura de tasas incorporadas.
- `POST /api/contracts/:id/late-fees/review`: registra una interpretación versionada del documento original, sin cambiar `late_fee_json` ni importes. Requiere `request_id`, `reason`, `document_id`, `document_reference`, `document_quote`, `confirm: true` y `terms`.
- `POST /api/late-fees/rates/import`: `{ "url": "https://www.boletinoficial.gov.ar/detalleAviso/primera/<aviso>/<AAAAMMDD>" }`. El servidor descarga sin redirecciones, valida el aviso y su tabla, conserva HTML/hash/fecha y carga solo intervalos reconocidos. No acepta tasas ni HTML suministrados por el cliente. No actualiza cuotas.
- `POST /api/installments/:id/late-fees/simulate`: `{request_id, operation, cutoff, reason, forgiven_amount?}`. `operation`: `calculate`, `forgive` o `restore`. Devuelve importe previo, bruto, condonado, neto, diferencia, saldo, días, tramos, bases, tasas y token. No escribe datos.
- `POST /api/installments/:id/late-fees/apply`: misma propuesta, `token` y `confirm: true`. Revalida snapshot, evidencia, pagos y condiciones; escribe en una transacción y audita. El mismo UUID aplicado se puede reintentar sin duplicar versiones.

Términos soportados, exclusivamente tras verificar su respaldo en el PDF:

```json
{
  "type": "BANK_ACTIVE_RATE",
  "product": "BNA_CARTERA_GENERAL_TNA_VENCIDA_30D",
  "dayBasis": 365,
  "startsFrom": "AFTER_DUE_DATE",
  "graceDays": 0,
  "base": "RENT_OUTSTANDING",
  "accumulation": "SIMPLE",
  "allocation": "RENT_FIRST",
  "periodicity": "DAILY",
  "paymentTiming": "START_OF_DAY",
  "cutoffConvention": "INCLUSIVE"
}
```

Para `FIXED_DAILY`, se usa `dailyPercentage` contractual, sin `product` ni `dayBasis`. También puede revisarse `FIRST_DAY_OF_MONTH` si consta en el documento: solo se devenga retroactivamente desde ese día cuando se ha superado el vencimiento/gracia. Para BNA se admiten bases 365 o 360 **si están explícitas en la cláusula**. No hay valores predeterminados para modalidad anual/base BNA.

La modalidad almacenada y el porcentaje fijo protegido deben coincidir; cambiar condiciones requiere su circuito documental. La revisión verifica PDF administrado, vínculo, SHA y fragmento extraído, además del respaldo textual de los parámetros soportados. Las cláusulas genéricas, otras bases, acumulación compuesta, multiplicadores, otros productos BNA o evidencia insuficiente quedan bloqueados. No es un sistema de interpretación jurídica automática.

El motor suma intereses simples por cada día civil incluido en el corte, con capital de alquiler impago y tasas históricas vigentes ese día. Pagos identificados reducen capital desde su fecha al inicio del día. Usa BigInt, fracciones exactas y redondeo final a centavos. Bloquea canon provisional, descuento general sin imputación identificada, pago manual sin fecha, cuota sustituida/cerrada, corte futuro, intervalos mayores a diez años o falta de una tasa. No extrapola la última tasa ni usa la actual como sustituto de una histórica.

La condonación es un importe absoluto del punitorio, con motivo; conserva bruto y cálculo. No afecta descuento general ni servicios. Si excede el bruto o el nuevo cálculo, se exige revisarla por separado. Una condonación histórica cuyo bruto se perdió no se restaura inventando un importe.

`PATCH /api/pending-collections/:id` rechaza modificaciones directas de punitorios, incluso con `confirm: true`. La creación inicial de un contrato admite `late_fee_type` y `late_fee_daily_pct`; eso conserva la condición, pero no habilita cálculos sin revisión/evidencia posterior.

### Sobrepagos y excedentes

El registro normal individual rechaza importes superiores al Debe, bajo el mismo bloqueo y transacción que registra la transferencia. Distribuir rechaza una solicitud superior al saldo total sin registrar una parte silenciosamente. Aumentar un pago manual por encima de la deuda tampoco permite crear un crédito implícito. Los sobrepagos históricos y sus claves anteriores se conservan.

- `POST /api/payments/:installmentId/excess/simulate`: datos completos del pago, `request_id` y `excess_reason`. Devuelve deuda disponible, dinero recibido, crédito previo, excedente y crédito resultante; no escribe.
- `POST /api/payments/:installmentId/excess/apply`: misma propuesta más `excess_token` y `excess_confirm: true`. Verifica el token propio y snapshot, registra el dinero recibido completo, audita motivo/actor/crédito e incorpora idempotencia en la misma transacción.

Un flag de autorización enviado al endpoint normal no permite sobrepagar. El excedente se registra en una cuota concreta, en la misma moneda, sin distribuir o devolver créditos automáticamente. Tokens de punitorios o servicios no habilitan la operación. Cambios de deuda/pagos invalidan la revisión. Reiniciar el proceso invalida tokens pendientes de ambos flujos (15 minutos).

La liquidación muestra Servicios netos una vez en la tabla de conceptos y lleva el detalle individual a un bloque informativo separado. Total, pagos y saldo proceden del backend; imprimir conserva el mismo desglose.
