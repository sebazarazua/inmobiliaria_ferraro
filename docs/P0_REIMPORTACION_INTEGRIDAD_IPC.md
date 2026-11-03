# Reimportación, estados e incorporación histórica IPC — informe P0

Fecha: 3 de noviembre de 2026. Base de trabajo: `13dcb86` (`main`, sincronizada con `origin/main` al comenzar). Sin commits ni push.

## Causa reproducida y estado de la instalación

El texto exacto `Ya fue analizado previamente (Revertido).` está en `contract-parser.js` del commit `c44bfa1`: cualquier intento anterior con estado Revisión, Error, Procesado, Descartado o Revertido devolvía Omitido, sin comprobar si su contrato seguía existiendo.

La inspección local encontró un único servidor en 4173: PID 9164, iniciado el 3 de noviembre a las 16:30:10, con `node backend/src/server.js`. Continuaba ejecutando los módulos cargados antes de la actualización a `13dcb86`. El frontend servido desde `frontend/dist` puede cambiar al reconstruirlo mientras ese backend sigue en memoria: eso explica que se vieran elementos nuevos junto con respuestas antiguas. Vite dirige `/api` a 4173; el frontend compilado usa el mismo origen.

La base local `inmobiliaria`, en PostgreSQL Docker 54329, tiene registrada la 013 y **no tiene aplicada la 014**. Se comprobó por lectura de `schema_migrations`. No se reinició ese servidor ni se migró esa base durante este trabajo. Las pruebas de navegador se conectaron exclusivamente a servidores temporales con puertos asignados por el sistema y bases de prueba independientes.

Con `AUTO_MIGRATE=false`, el arranque ahora exige todas las migraciones presentes en el repositorio, incluida la 014. Antes comprobaba solamente la 013 y podía iniciar con un esquema incompatible.

## Correcciones

### Reimportación

- Un PDF nuevo se analiza y pasa a revisión. Un contrato se crea únicamente al confirmar sus datos.
- Si el SHA-256 está vinculado a un contrato existente, la subida explica `Este documento ya está asociado a un contrato existente.` y ofrece abrir ese contrato. El vínculo funciona también para contratos archivados.
- Se revisan `documents.contract_id`, `contracts.source_document_id` y las referencias de los intentos históricos; un intento fallido posterior no oculta un contrato todavía existente.
- Si el contrato fue eliminado o la importación revertida, la subida devuelve `Confirmación requerida`, sin crear otro intento. El diálogo ofrece Cancelar y Volver a importar con el mensaje solicitado.
- La confirmación usa la operación específica `document-admin/reprocess` con `confirm:true`. Vuelve a clasificar el SHA bajo el bloqueo de importación. Esta confirmación no evita el bloqueo de duplicados, las exclusiones ni la revisión posterior.
- Revisión, Error, Descartado y Revertido mantienen intentos independientes; `previous_import_id` apunta al intento anterior significativo. Un Omitido residual no bloquea la recuperación ni reemplaza esa referencia.
- Los reintentos desde Importaciones y Documentos conservan las lecturas anteriores. El scanner no reimporta por su cuenta documentos históricos.
- Si una referencia histórica apunta a Windows y el archivo se vuelve a subir en la Mac, se localiza la copia administrada por su SHA; la referencia del intento anterior permanece en el historial.
- La persistencia física se serializa por contenido y busca también PDFs de la carpeta aún sin registro. Doce subidas simultáneas del mismo PDF producen una sola copia y un solo intento. También se probaron doce PDFs diferentes en paralelo, incluida la confirmación y reutilización de personas.
- Los procesos que esperan el bloqueo devuelven su conexión al pool; no impiden que el dueño del bloqueo persista su resultado.
- La confirmación del contrato valida nuevamente sus relaciones. Una reimportación no puede superponerse con otro contrato vigente de la propiedad. El circuito existente de importación y vinculación de una renovación inicial se conserva.
- Las entidades se reutilizan por DNI y dirección. Se conserva el documento existente si quedó sin contrato.
- Los códigos de importación se asignan a partir del máximo sufijo existente, evitando colisiones después de borrar un contrato intermedio.

### Reactivación y visualización

La reactivación ya no escribe estados ni importes de cuotas. Se conservan las cuotas vencidas legítimas, parciales, pagadas, sustituidas, sus ajustes IPC y sus pagos.

En registros antiguos sin captura del estado previo por cuota no existe evidencia suficiente para determinar qué Vencido fue impuesto por la desactivación. Se mantienen esos estados y se devuelve un aviso de revisión, también registrado en la auditoría de reactivación. La restauración de un archivo antiguo no inventa un estado previo que oculte esa incertidumbre.

La visualización compartida conserva la etiqueta Parcial y la etiqueta Sustituido, aunque haya pasado su vencimiento.

### Incorporación IPC histórica

Se reutilizan el cálculo IPC existente, `reconcileOnClient`, `reconcileInstallments`, `refreshAndUpdate` y `rent_adjustment_history`. No hay un motor alternativo.

La simulación incluye contratos activos e históricos y excluye las obligaciones Sustituido. Detecta cuotas sin incorporar, cronogramas incompletos, condiciones ambiguas, diferencias, pagos y correcciones manuales. Presenta por contrato:

- Estado contractual, condiciones, canon inicial y canon actual calculable.
- Cantidad de cuotas, cambios e índices todavía pendientes.
- Importes anteriores y contractuales, diferencias, pagos recibidos y saldo/crédito.
- Aumentos históricos con períodos, niveles e índices utilizados.
- Clasificación: listo, requiere revisión o bloqueado. Las cláusulas ambiguas se identifican como revisión pendiente y no se pueden aplicar mientras impidan calcular.

Las condiciones incompletas y los cronogramas inconsistentes se bloquean. Los acuerdos manuales y diferencias históricas requieren revisión explícita; los overrides identificados se conservan. Los contratos tienen enlace a sus operaciones existentes para resolver las excepciones.

La aplicación por lote acepta solo los contratos seleccionados, su simulación vigente, motivo y confirmación de revisión. Admite hasta 500 contratos por solicitud y usa **una transacción por contrato**. Si uno está bloqueado o cambió después de la simulación, ese contrato informa el error y los demás aprobados pueden aplicarse. Cada cuota modificada o incorporada registra una nueva versión y conserva su importe original.

La huella de la simulación contempla condiciones financieras, estados, obligaciones, pagos y correcciones. Un pago, descuento o cambio contractual invalida el permiso anterior. La metadata administrativa sin impacto financiero no genera una discrepancia entre simular y guardar el formulario de edición.

Simular no confirma cambios económicos. Aplicar modifica las obligaciones revisadas y su trazabilidad. Ninguna de las dos operaciones borra ni modifica pagos, crea cobros, envía comunicaciones o reescribe movimientos contables.

Después de incorporar un contrato antiguo, las publicaciones siguientes pasan por la actualización programada o la consulta manual existentes. Los importes se persisten, las pantallas leen esos mismos registros y repetir la actualización no genera aumentos ni versiones duplicadas. Cuando falta el índice, se conserva el último canon válido y la cuota queda provisional.

## Archivos

| Archivo | Cambio |
| --- | --- |
| `backend/src/app.js` | Persistencia física concurrente, respuesta de confirmación, reactivación sin recalcular, aplicación IPC por lotes. |
| `backend/src/database/index.js` | Validación de migraciones requeridas al iniciar sin migración automática. |
| `backend/src/modules/imports/contract-parser.js` | Clasificación, bloqueos, confirmación, historial, códigos y validación de reimportación. |
| `backend/src/modules/imports/document-admin.js` | Recuperación, exclusiones serializadas y referencias históricas por SHA. |
| `backend/src/modules/rent/index.js` | Detección, resúmenes, cronogramas, simulaciones vigentes y aplicación independiente por contrato. |
| `frontend/src/components/ReimportConfirmation.jsx` | Diálogo compartido con las dos acciones solicitadas. |
| `frontend/src/components/IpcAdministration.jsx` | Selección de contratos, resumen y revisión de excepciones. |
| `frontend/src/pages/ResourcePage.jsx` | Subida con confirmación, reintentos y acceso al contrato correspondiente. |
| `frontend/src/pages/DocumentAdminPage.jsx` | Confirmación y acceso al contrato desde Documentos. |
| `frontend/src/utils/format.js` | Conservación de estados Parcial y Sustituido al visualizar. |
| `tests/lifecycle.test.js` | Casos de recuperación, concurrencia, integridad, migraciones y rutas Windows. |
| `tests/ipc.test.js` | Detección, lotes, pagos, cambios de índices, histórico e idempotencia. |
| `tests/ipc-browser.test.js` | Recorrido existente adaptado a selección explícita y validación de edición completa. |
| `tests/p0-browser.test.js` | Los cuatro escenarios completos solicitados con comprobaciones en PostgreSQL. |
| `tests/support/p0-fixtures.js` | PDF sintético y personas ficticias para los escenarios nuevos. |
| `package.json` | `test:browser` incluye ambos recorridos. |
| `docs/P0_REIMPORTACION_INTEGRIDAD_IPC.md` | Este informe. |

**Migraciones nuevas: ninguna.** Se utilizan los campos aditivos de la 013 y la 014, sin modificar esos archivos.

## Validación y evidencia

| Comando | Resultado |
| --- | --- |
| `pnpm test` | 91 pruebas aprobadas, 0 fallos; incluye las 76 existentes y 15 casos P0 nuevos. |
| `pnpm test:browser` | 2 pruebas aprobadas, 0 fallos, con Chrome y Playwright CLI. |
| `pnpm test:ipc:live` | 1 prueba aprobada: fuente INDEC real → PostgreSQL aislado → cuotas → API → conciliación. |
| `pnpm check` | Sintaxis, gateway y compilación frontend aprobados. |
| `git diff --check` | Sin errores. |

En esta Mac se indicó `PG_BIN=/opt/homebrew/opt/postgresql@17/bin`. `PLAYWRIGHT_CLI` debe señalar el `playwright-cli.js` instalado. Los runners crean y eliminan clústeres PostgreSQL y carpetas temporales, sin usar la base de `.env`.

La matriz P0 agregada simula **10 contratos antiguos por API/PostgreSQL y 2 en el nuevo escenario de navegador**. Además se ejecutaron el caso antiguo del navegador preexistente y el caso de descarga real. Ninguna de esas cantidades corresponde a contratos de la instalación real.

El escenario de reimportación creó un contrato desde un PDF ficticio, lo eliminó desde la vista de impacto, volvió a subir exactamente sus bytes, canceló el aviso y verificó que no hubiera otro intento. Luego confirmó el reanálisis, verificó que todavía no hubiera contrato, completó la revisión y comprobó un contrato nuevo, los mismos IDs de personas y propiedad, un único documento, una sola copia física y la cadena de intentos.

El escenario histórico importó un contrato iniciado en noviembre de 2025. Con los niveles almacenados de la fixture: febrero de 2026 $542.127,25; mayo $591.589,61; agosto $628.725,89. Noviembre quedó provisional porque la fixture oficial llega a septiembre. Una publicación **sintética de octubre**, exclusiva de pruebas, permitió verificar la actualización posterior a $666.398,56 y conservar los pagos. Ese nivel sintético no se presenta como una publicación real de INDEC.

El escenario antiguo incorporó P0-ANTIGUO con una cuota de abril inicialmente registrada y cobrada por $500.000: persistió un canon contractual de $547.211,45 con diferencia pendiente $47.211,45, conservando la transferencia. P0-BLOQUEADO no fue incorporado. Una simulación posterior no produjo cambios nuevos.

El escenario de reactivación utilizó cuotas Vencido, Parcial y Pagado con pagos reales dentro del clúster temporal. Las acciones de desactivar y reactivar se ejecutaron desde el menú del navegador y sus registros financieros se compararon completos antes y después.

Capturas y comprobantes, fuera del control de versiones:

- `tmp/p0-verification/reimport-confirmation.png`: aviso y botones.
- `tmp/p0-verification/new-review.png`: nueva revisión, antes de crear el contrato.
- `tmp/p0-verification/ipc-batch-preview.png`: selección y diferencias históricas.
- `tmp/p0-verification/reactivated-contract.png`: contrato reactivado.
- `tmp/p0-verification/pending-collections.png` y `dashboard.png`: pantallas posteriores.
- `tmp/p0-verification/ipc-mobile.png`: visualización móvil, tablas con desplazamiento horizontal.
- `tmp/p0-verification/evidence.json`: IDs temporales y comprobaciones del recorrido.
- `tmp/ipc-browser-settings.png`, `tmp/ipc-browser-mobile.png`, `tmp/ipc-live-verification.json`: evidencia de las verificaciones existentes.

## Límites y despliegue controlado

Las pruebas funcionales y de navegador están completas en aislamiento. La **actualización de la instalación local real sigue pendiente**: conserva el servidor anterior y la base en la 013. No debe considerarse que 4173 ya ejecuta esta corrección por ver el frontend reconstruido.

1. Detener el proceso anterior durante la ventana de actualización y guardar un respaldo verificable de PostgreSQL y de los PDFs.
2. Revisar la migración 014 y este diff. Probar sobre una copia de la instalación; las migraciones no incorporan cuotas históricas automáticamente.
3. Instalar con el lockfile y ejecutar `pnpm check` y las pruebas aisladas con las rutas PostgreSQL/Playwright correspondientes.
4. Verificar explícitamente host/base de destino. **Con aprobación para la base real**, ejecutar `node --env-file=.env backend/scripts/migrate.js`; no habilitar la migración automática como atajo de despliegue.
5. Iniciar `AUTO_MIGRATE=false pnpm start` con la configuración de la instalación y comprobar que solo un proceso atienda 4173. Recargar el navegador para utilizar el frontend del mismo despliegue.
6. En Configuración, simular todos los IPC, revisar cada excepción y seleccionar los contratos aprobados. Ingresar motivo, confirmar y aplicar. Los no aprobados quedan pendientes.
7. Comprobar contratos, cuotas, transferencias, saldos y versiones antes/después. Repetir la simulación para confirmar idempotencia y conservar la evidencia de la instalación.

Los estados antiguos sin evidencia y los acuerdos manuales no identificados siguen requiriendo revisión documental. Los cronogramas incompletos deben corregirse antes de incorporar ese contrato. No se aplicó ninguna conciliación inicial ni se modificaron datos reales durante esta implementación.

No se modificaron PDFs existentes, `.env`, `.gitignore`, migraciones anteriores ni el historial Git. No se cambiaron módulos de recibos, WhatsApp, Banco Nación o punitorios ni se agregaron dependencias. Se conservaron los archivos y cambios locales ajenos a la tarea, incluidos los PDFs sin seguimiento que ya estaban o aparecieron en el espacio de trabajo durante la sesión.
