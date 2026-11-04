# Protección contractual y organización mensual de cobros — P1

Fecha: 4 de noviembre de 2026. Base: `a29e291`, sincronizada con `origin/main` al comenzar. Sin commits ni push.

## Antes y después

Antes, Editar contrato enviaba condiciones económicas y podía aplicarlas con un token de conciliación y una confirmación del cliente. Incluso una edición administrativa podía ejecutar conciliación. Cobros Pendientes utilizaba un control mensual del sistema operativo y una tabla continua.

Ahora:

- Editar contrato guarda únicamente alias y una anotación administrativa separada. Las condiciones originales se muestran como información de consulta y hay acceso al PDF.
- El backend impide cambiar condiciones por PATCH, incluso usando confirmaciones o tokens del circuito anterior. PUT continúa sin estar habilitado.
- Rectificar datos del contrato es otra operación: requiere documento original verificable, motivo, cláusula/página, fragmento literal, comparación, simulación y confirmación.
- La modificación por adenda está bloqueada; la renovación conserva su circuito de nuevo contrato con PDF propio.
- El selector de mes/año es un popover de doce meses, con año editable, navegación y teclado. No usa `input type="month"` en Cobros Pendientes.
- Una sola tabla organiza las cuotas por período, con encabezados mensuales, cantidad y subtotales separados por moneda. No se recalculan alquileres en el frontend.

## Clasificación de datos y operaciones

| Categoría | Campos / información | Tratamiento |
| --- | --- | --- |
| Administrativa | Alias interno | Editable por PATCH, sin conciliar ni modificar cuotas. |
| Administrativa nueva | Nota administrativa | Se conserva en la auditoría y se consulta por el endpoint de protección. No reemplaza las notas contractuales existentes. |
| Económica contractual | Canon inicial, moneda, mecanismo, índice, frecuencia, porcentaje, rezago y cláusula | Protegida en edición normal. Solo puede rectificarse si existe respaldo documental y el impacto puede simularse por completo. |
| Vigencia y cronograma | Inicio, finalización, duración, día de vencimiento y período de pago | Protegidos. Cambiarlos exige revisar un cronograma que este trabajo no recrea; la rectificación se bloquea. |
| Otras obligaciones | Punitorios, condiciones de pago/anticipos, IVA, depósito, honorario de administración, tipo de alquiler | Protegidas. Su rectificación financiera no se implementa como un cambio administrativo. |
| Destino de pagos | Banco y CBU | Protegidos: no se consideran una simple etiqueta interna. |
| Identidad y respaldo | Código, inmueble, inquilino, PDF original, contrato anterior y snapshot de importación | No se reasignan por PATCH ni por la rectificación de importes. |
| Notas existentes | `contracts.notes` | Pueden contener cláusulas manuales. Se conservan como información protegida; las notas administrativas nuevas se guardan por separado. |
| Ciclo de vida | Estado, rescisión, renovación, archivo y devolución de depósito | Mantienen las operaciones específicas existentes. No se autorizan mediante la edición normal. |

La protección se aplica a los registros persistidos en `contracts`, incluidos contratos antiguos y contratos confirmados cuyo estado sea Revisión por observaciones del parser. Cambiar o archivar un estado no desbloquea condiciones. Los borradores de importación siguen pudiendo corregirse en `imports` antes de crear el contrato; creación y revisión inicial conservan sus formularios.

Para compatibilidad con clientes anteriores, PATCH puede recibir valores contractuales iguales a los guardados, pero los ignora al persistir administración. Se normalizan fechas civiles, decimales, enteros, nulos y la equivalencia de rezago 0/1. No se reescribe el dato original solo por tener un formato equivalente. Los identificadores, como CBU, conservan su significado literal.

## Rectificación documentada

### Precondiciones del servidor

1. El propósito debe ser corrección de carga del documento original. Adendas y contratos nuevos no son propósitos admitidos.
2. El documento debe ser el `source_document_id` de ese contrato y conservar su vínculo. Un adjunto posterior no basta.
3. El PDF debe existir en la carpeta administrada, ser un archivo permitido y conservar el SHA-256 registrado.
4. Motivo y referencia deben ser texto. Se exige un motivo suficientemente descriptivo y un fragmento de al menos 20 caracteres útiles.
5. El fragmento se verifica contra el texto extraído del PDF real, no solo contra una casilla del formulario o un texto enviado por el cliente.
6. Los valores propuestos deben tener respaldo explícito en ese fragmento: frecuencia reconocible, canon numérico, mecanismo IPC, rezago explícito y cláusula correspondiente, según lo que se corrija. Citar una frase existente no permite introducir otros valores.
7. La simulación debe estar vigente y no bloqueada.

La comparación muestra los valores anteriores y propuestos y las cuotas que cambiarían: importes previos y nuevos, pagos recibidos y saldo/crédito. Se usa `reconcileOnClient` del motor existente, sin un segundo cálculo de alquileres.

La operación de simulación actualiza provisionalmente las condiciones dentro de un savepoint y lo revierte. No confirma condiciones, importes ni pagos. Devuelve un token propio HMAC, con vencimiento de 30 minutos, vinculado al contrato, propuesta, motivo, evidencia, pagos, cuotas, movimientos y versiones.

Aplicar vuelve a verificar todo dentro de una transacción, con bloqueo de contrato y el bloqueo financiero existente. Un pago nuevo, cambio de condiciones, documento alterado o simulación manipulada exige simular de nuevo. Una confirmación genérica o un token de la vieja edición no autorizan esta operación.

La aplicación registra una versión en `audit_log`: actor disponible, fecha, motivo, PDF y SHA, fragmento y referencia, valores anteriores, propuesta, comparación y cuotas afectadas. Las versiones de importes siguen en `rent_adjustment_history`. El historial puede consultarse desde la ventana de rectificación. Dos confirmaciones simultáneas producen una sola versión.

Se conserva el documento original, el snapshot de importación, los pagos y los movimientos contables. La rectificación no genera cobros, comunicaciones, créditos adicionales ni liquidaciones retroactivas automáticas. Una cuota ya pagada puede mostrar una diferencia después de una corrección documental revisada, conservando exactamente la transferencia recibida.

También se impide que Subir archivos reasigne a otro contrato un PDF que ya respalda un contrato existente. Se preserva así la identidad de la evidencia original.

### Alcance y límites

Se permite simular rectificaciones de canon inicial, frecuencia, rezago, cláusula y coherencia de mecanismo/índice cuando el resultado es IPC y puede calcularse con el motor actual. Puede corregirse una lectura errónea hacia IPC si el original lo respalda. No se implementaron cálculos para mecanismos manuales ni conversión de monedas.

Cambios de moneda, vigencia, duración, vencimientos, punitorios, partes, depósitos, honorarios y otros impactos no simulables quedan bloqueados. La ventana no ofrece un bypass para forzarlos. Un cronograma incompleto, una condición ambigua pendiente o una cuota fuera de vigencia también impiden aplicar.

La verificación del texto es conservadora: un PDF sin texto extraíble o un fragmento ambiguo/no reconocible requiere resolver la evidencia antes de aplicar. No pretende sustituir una interpretación jurídica ni certificar una firma. La aplicación actual no tiene sesiones de usuario autenticadas; la auditoría identifica honestamente al **operador local**, asignado por el servidor. No toma un actor enviado por el cliente como permiso.

Los tokens pertenecen al proceso servidor que los emitió. Reiniciar el backend invalida las simulaciones pendientes: deben repetirse. Un despliegue con varios procesos requeriría una estrategia compartida de autorización antes de distribuir este flujo.

### Adendas: tarea futura, bloqueada en esta entrega

Una adenda necesita documento nuevo, vinculación a las partes y al contrato original, cláusulas versionadas, fecha efectiva por condición, revisión de impacto y aprobación diferenciada. No debe sobrescribir el contrato original ni reinterpretarse como un error de carga. Cualquier retroactividad necesita una referencia expresa al documento y revisión de pagos y liquidaciones. Ese circuito no se implementó aquí. La renovación por contrato nuevo conserva la operación existente y no cambia las condiciones originales del anterior.

## Selector y agrupación mensual

`MonthYearPicker` conserva el valor `YYYY-MM`. Presenta doce meses en español, año editable, botones de año anterior/siguiente, selección, Todos los meses, foco visible y cierre con Escape o clic fuera. Las flechas recorren meses; Inicio/Fin y PageUp/PageDown permiten navegación rápida. El año se valida entre 1 y 9999.

Se corrigió específicamente la pérdida de foco de WebKit al pulsar los botones de año: ese clic no cierra el popover. No se depende del selector mensual de macOS o Windows.

Por defecto se muestran todos los meses. La selección y el contrato pueden combinarse y permanecen al actualizar los datos, incluso después de Escanear contratos. Se conserva el período en el estado de la página y en el hash, sin eliminar el filtro de contrato. Los períodos se formatean con UTC para no desplazarlos por zona horaria.

La agrupación reutiliza `periods.mjs`:

- Se utiliza `installments.period`, no vencimiento ni fecha de pago.
- Los grupos se ordenan cronológicamente y sus cuotas por vencimiento.
- Cada ID aparece una sola vez; un período inválido se conserva en Período por revisar.
- Cantidad y subtotales se muestran en el encabezado del grupo.
- Solo se suman los `due_amount` autoritativos de la API, con acumulación en centavos y sin sumar monedas diferentes. El frontend no reconstruye el saldo, IPC, IVA, descuentos o punitorios.
- Filtrar un mes conserva un solo grupo con su subtotal. Filtrar un contrato restringe los grupos a sus cuotas.
- Hay una sola tabla, encabezado de columnas compartido y un cuerpo por grupo. En móvil, la información mensual se ajusta y la tabla mantiene su desplazamiento horizontal.

Continúan funcionando el detalle desde el importe, el lápiz de alquiler, IVA, punitorios, descuentos, pago parcial, notas, registro de cobro y liquidación del inquilino. Los cambios de presentación no alteran importes ni pagos.

## Archivos

| Archivo | Cambio |
| --- | --- |
| `backend/src/modules/contracts/protection.js` | Clasificación, equivalencia de valores y rechazo de cambios administrativos no autorizados. |
| `backend/src/modules/contracts/rectification.js` | Evidencia original, simulación firmada, aplicación transaccional e historial. |
| `backend/src/app.js` | Edición administrativa separada, rutas documentales y protección del vínculo del PDF. |
| `frontend/src/components/ContractEditModal.jsx` | Administración editable y condiciones de solo lectura. |
| `frontend/src/components/ContractConditions.jsx` | Presentación legible de condiciones guardadas. |
| `frontend/src/components/ContractRectificationModal.jsx` | Evidencia, motivo, propuesta, comparación, simulación e historial. |
| `frontend/src/components/MonthYearPicker.jsx` | Selector independiente del sistema operativo. |
| `frontend/src/pages/ResourcePage.jsx` | Nueva acción, filtros combinados/persistentes y grupos mensuales. |
| `frontend/src/utils/periods.mjs` | Agrupación y subtotales por moneda, sin duplicar el filtrado. |
| `frontend/src/styles.css` | Estilos acotados a los componentes nuevos. |
| `tests/p1-contracts.test.js` | Protección, evidencia, simulación, pagos, concurrencia, renovación y agrupación. |
| `tests/p1-browser.test.js` | Recorridos completos Chrome/WebKit en escritorio y móvil. |
| `tests/support/month-picker.js` | Interacción de navegador compartida con el selector público. |
| `tests/ipc.test.js`, `tests/ipc-browser.test.js` | Regresión adaptada: la vieja edición económica ahora se rechaza; administración y motor continúan probándose. |
| `tests/contract-ux.test.js`, `tests/contract-ux-browser.test.js`, `tests/p0-browser.test.js` | Regresiones administrativas, documentales y del nuevo selector. |
| `tests/run-isolated.js`, `package.json` | Incorporación de las pruebas nuevas. |
| `docs/API.md` | Contrato actualizado de PATCH y rutas de rectificación. |
| `docs/P1_PROTECCION_CONTRACTUAL_COBROS_MENSUALES.md` | Este informe. |

**Migraciones nuevas: ninguna.** Se utiliza la estructura de auditoría y versiones existente. No se modificaron migraciones anteriores ni se añadieron dependencias.

## Pruebas y evidencia

| Comando | Resultado |
| --- | --- |
| `pnpm test` | 108 pruebas aprobadas, 0 fallos: las 95 previas y 13 casos P1. |
| `pnpm check` | Sintaxis, comprobaciones existentes y build aprobados. |
| `UX_BROWSERS=chrome,webkit pnpm test:browser` | 6 pruebas aprobadas, 0 fallos: regresiones IPC/reimportación, UX Chrome/WebKit y P1 Chrome/WebKit. |
| `git diff --check` | Sin errores. |

Las pruebas de datos usan PostgreSQL temporal y carpetas de prueba. Se ejecutaron con `PG_BIN=/opt/homebrew/opt/postgresql@17/bin` y el Playwright CLI instalado, indicado mediante `PLAYWRIGHT_CLI`. Los archivos de prueba sintéticos no se guardan en la carpeta real de contratos.

Se probaron solicitudes directas a la API con confirmaciones y tokens falsos/antiguos, formatos equivalentes de contratos anteriores, evidencia insuficiente, PDF alterado, adjunto posterior, propuestas no respaldadas por la cita, simulación bloqueada, pagos nuevos que invalidan la simulación y confirmaciones simultáneas. También se verificó que una renovación conserva las condiciones originales.

En el recorrido de navegador:

- Se cargaron tres contratos y 54 cuotas, con ARS y USD, pagos parciales y vencimientos deliberadamente distintos del período.
- Se verificaron orden, IDs únicos, grupos de distintos años y subtotales separados por moneda.
- Se combinaron ambos filtros, se actualizó la página mediante el escaneo existente y se conservó la selección.
- Se probaron teclado, cambio rápido de año, mes fuera del cronograma, Todos los meses y móvil.
- Se abrieron y cancelaron todos los modales de cobro existentes sin escribir datos.
- Se guardó administración sin alterar cuotas, pagos o versiones.
- Se simuló y aplicó una rectificación respaldada por el PDF original, conservando pagos y movimientos.

Las capturas están en `tmp/p1-verification/chrome/` y `tmp/p1-verification/webkit/`:

- `all-months-desktop.png`: una sola tabla con grupos y monedas separadas.
- `month-year-picker.png`: doce meses y navegación de año.
- `month-picker-mobile.png` y `month-group-mobile.png`: presentación a 390 × 844.
- `protected-administrative-form.png`: condiciones consultables, sin selectores económicos.
- `rectification-simulation.png`: evidencia y comparación revisada.
- `evidence.json`: verificaciones e importes del escenario aislado.

Los logs finales están en `tmp/p1-verification/tests.log`, `browser.log` y `check.log`. Los artefactos quedan fuera del control de versiones. La validación de escritorio se realizó a 1440 × 1000 y la móvil a 390 × 844. Chrome y WebKit se ejecutaron en esta Mac; Windows, Edge y Safari nativo no se ejecutaron por separado. El selector usa controles web propios comunes a esos entornos.

## Despliegue controlado

1. Revisar este diff y realizar el respaldo habitual de base y documentos antes de actualizar la instalación.
2. Usar el esquema actual del proyecto, incluidas 013 y 014. Esta entrega no agrega migraciones ni las ejecuta sobre la base real.
3. Instalar con el lockfile, ejecutar `pnpm check` y las pruebas aisladas con los binarios requeridos.
4. Servir el frontend compilado y reiniciar el backend con esta misma versión. Usar `AUTO_MIGRATE=false` para impedir migraciones automáticas no revisadas. La protección de servidor no se activa únicamente reconstruyendo el frontend.
5. Comprobar la edición administrativa y los filtros sin rectificar datos reales como prueba de despliegue. Una rectificación real debe hacerse solo después de cotejar el PDF, revisar su simulación y confirmar el alcance.
6. Conservar la evidencia y auditoría de cualquier rectificación efectivamente aprobada. Un contrato bloqueado debe revisarse, no forzarse por API.

No se hicieron pruebas destructivas, rectificaciones ni migraciones sobre la base real. No se modificaron PDFs del usuario, privacidad del repositorio, `.env`, logo, paleta, sidebar, fórmulas IPC, fuente INDEC, pagos históricos, WhatsApp, recibos ni cálculo de Banco Nación. No se hicieron commits ni push.
