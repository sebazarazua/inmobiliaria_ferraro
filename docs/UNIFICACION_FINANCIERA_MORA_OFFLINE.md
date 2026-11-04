# Servicios, gastos, cobros y mora offline — Prompt 09

Fecha: 4 de noviembre de 2026. Base: `25ce521`, HEAD y origin/main coincidentes después de consultar GitHub. Desarrollo local, sin commit, push ni despliegue. Durante este prompt no se aplicaron migraciones ni operaciones en la base real. Las migraciones 015 y 016 habían sido aplicadas anteriormente con autorización; esta entrega añade 017 y requiere otro despliegue controlado.

## Diagnóstico y arquitectura

Servicios mostraba gastos contables, mientras las obligaciones de cuotas se administraban en otro circuito. No existía un guardado conjunto gasto/cargo, ni baja auditable de gastos. Cobros pendientes tenía doce columnas y un ancho mínimo de tabla/acciones que obligaba a desplazarla. Mora tenía revisión manual y avisos oficiales incorporados mediante URL. Dos suites de regresión dependían de un PDF real local; había dos snapshots, dos PDFs y un archivo de metadatos de carpeta en Git.

La fuente única de la obligación sigue siendo `installment_services`. No se creó un segundo motor ni una tabla alternativa de deudas. La clasificación nueva `charge_kind` distingue `service`, `recoverable` y `other`. `service_rules` conserva esa clasificación al generar cuotas. Los registros anteriores reciben `service` sin cambiar importes, condonaciones o estados.

```text
Servicios / Cobros pendientes → mismo InstallmentServicesModal → mismo serviceOperation
Gasto trasladable revisado    → gasto + serviceOperation, en una sola transacción
installment_services         → proyección SQL services_amount → balance() común
                             → pendientes, pago, liquidación, dashboard e IPC existente
```

`services_amount` conserva su nombre por compatibilidad: es el total neto de los cargos confirmados, incluidas las tres clasificaciones. `charges_breakdown` desglosa cada clasificación en NUMERIC como texto. Este desglose se calcula en el backend; no vuelve a sumarse al saldo. `balance()` y las fórmulas IPC no se modificaron. La lectura de pendientes y su desglose usa un snapshot PostgreSQL consistente de solo lectura.

## Servicios desde cualquier pantalla

La pestaña muestra todos los cargos con propiedad, contrato, inquilino, período, categoría, original, condonado, neto, estado y origen. Incluye filtros por propiedad, contrato, categoría, estado y mes/año, y totales confirmados separados por moneda. Los borradores y anulados no integran esos totales exigibles.

Agregar permite elegir la combinación propiedad/contrato y la cuota. Administrar/historial abre exactamente `InstallmentServicesModal`, también utilizado desde Cobros pendientes y Contratos. Allí están altas únicas, recurrencias fijas/variables, edición, condonación, restauración, retiro, saldo e historial. Abrir cuota conduce a pendientes con contrato y período filtrados; una cuota pagada puede consultarse desde Administrar aunque no figure en pendientes.

Las dos pantallas consultan la misma identidad de cargo. Al actualizar, los cambios se reflejan en ambas. No hay sincronización mediante copias ni creación de otra obligación. La generación recurrente mantiene la unicidad por regla/cuota y no traslada reglas a renovaciones.

Los gastos históricos de servicios continúan consultables en otro bloque, con estados y totales contables propios por moneda. Gastos muestra todos los movimientos de tipo Gasto, incluidos los de categoría Servicio; son vistas del mismo asiento, no registros duplicados. Un cargo no se contabiliza como ingreso recibido.

## Gasto y cargo conjunto

El nuevo formulario permite responsable propietario, inmobiliaria, inquilino o pendiente. Los primeros, y pendiente de determinar, crean únicamente un gasto contable. Para inquilino exige propiedad, contrato, cuota existente, moneda compatible, concepto e importe. En esta versión cada gasto se asigna a una sola cuota, por un importe no mayor al gasto. No se distribuye una factura automáticamente entre varios meses.

Con respaldo y declaración explícita revisados se propone un cargo Confirmado. Sin esos datos se registra el gasto y un cargo Borrador pendiente de revisión, sin aumentar el Debe. La categoría Servicio produce clasificación `service`; los demás gastos usan `recoverable`. La categoría nunca determina por sí misma la responsabilidad.

El circuito es motivo → revisión conjunta → confirmación. La vista previa informa ambos registros y saldo anterior/nuevo, incluida la reapertura de una cuota pagada. Simular revierte cualquier inserción temporal antes de responder; no deja gastos, cargos ni auditorías persistidos. Confirmar revalida el snapshot con token firmado de 15 minutos, bajo el bloqueo financiero común, y guarda gasto, cargo, proyección, estado, auditorías e idempotencia en una sola transacción. El módulo existente de servicios admite un cliente transaccional interno para este fin; sus validaciones y saldo siguen compartidos.

Una falla de cuota, moneda, proyección o auditoría revierte la operación completa. Para guardar únicamente el gasto, el operador debe realizar una nueva decisión explícita como pendiente/propietario/inmobiliaria. No existe un fallback silencioso a un guardado parcial.

El UUID de solicitud se conserva en reintentos. Dos confirmaciones simultáneas no duplican el asiento ni el cargo. El mismo UUID con otro contenido se rechaza. Se impide vincular otra obligación al mismo gasto, incluso después de anular su cargo; los vínculos históricos repetidos, si existieran, se conservan y pueden reducirse sin inventar una migración económica. Un gasto asignado expresamente a propietario/inmobiliaria no puede vincularse como deuda por otra pantalla.

## Anulaciones, pagos y créditos

Servicios reutiliza su anulación lógica con motivo, simulación y confirmación. Conserva el original, condonación, actor, fecha, saldo antes/después y pagos. Si retirar o condonar un cargo cobrado genera crédito, la revisión de servicios lo muestra antes de aplicar. No se elimina ni devuelve una transferencia automáticamente.

Gastos ofrece Anular gasto, con motivo y vista previa de cargos asociados, cuotas y pagos. Se utiliza siempre una marca lógica, aunque el gasto no tenga vínculos, para conservar el asiento y su auditoría. Los totales contables vigentes excluyen anulados; la fila original sigue visible. No se borran físicamente registros financieros.

Cuando hay un cargo asociado, la operación exige confirmar que se conserva y que cualquier corrección de deuda se hará por separado desde Servicios. Anular el gasto no anula una deuda cobrada ni genera un crédito de forma implícita. La respuesta y el modal muestran este límite. Un cargo vinculado a un gasto anulado admite reducción/retirada posterior auditada, pero no un aumento. Movimientos del circuito de devolución de depósito se bloquean para corrección coordinada en su circuito original; no se reinterpretan como gastos independientes.

Pago y liquidación presentan Servicios netos, Gastos trasladables y Otros cargos por separado cuando existen. Cada concepto entra una sola vez en la tabla económica. El detalle informa la clasificación, original, condonado y neto incluido. Total, pagos, saldo y crédito siguen viniendo del backend. Se preservan idempotencia, distribución transaccional, protección de sobrepagos e impresión existentes.

## Cobros pendientes compacto

Se extrajo `CompactPendingCollectionsPanel`: ocho columnas, fecha `dd/mm/aa`, propiedad/arrendatario compactos con texto completo al pasar el cursor, alquiler con detalle IPC, cargos agrupados con sus controles individuales, descuento, pagos, Debe y acciones. Cobrar y Liquidación están visibles; las notas se consultan mediante su botón en acciones. Un canon provisional sin saldo conserva Esperando índice y no permite cobrarlo otra vez.

Se conservan filtros combinados, selección después de recargar, una tabla agrupada por `installments.period`, subtotales por moneda, detalle IPC y ediciones anteriores. Los estilos específicos no alteran logo, paleta ni sidebar. A 1366 × 768, con sidebar visible, se comprueba ancho interno de tabla y tarjeta y posición del botón Cobrar. En móvil se usan filas de dos columnas tipo tarjeta, con las acciones al pie y sin desplazamiento lateral de la página. Las tablas extensas de un modal conservan su propio desplazamiento interno.

## Detección documental de mora

Al abrir Punitorios se analiza el PDF original administrado, verificando pertenencia, ruta y SHA. PDF.js extrae texto página por página. Se identifican fragmentos y referencias de cláusula cuando están presentes; se conserva la página física del PDF, no una página inferida del texto o nombre del archivo.

Las heurísticas proponen tipo de tasa, porcentaje, inicio, gracia, vencimiento/ventana de pago, capital, acumulación, periodicidad, imputación de pagos, momento de pago, corte, modalidad bancaria y base anual. La salida conserva el fragmento, parámetros encontrados, campos sin determinar, alternativas, confianza y estado de revisión. No mencionar gracia o día de vencimiento deja el campo sin determinar; no se presenta como dato detectado por defecto. Un vencimiento explícito que contradiga la condición protegida bloquea la revisión económica y requiere cotejo documental, sin cambiar cuotas. Exclusiones de punitorios, porcentajes alternativos, modalidades incompatibles y capitalización se señalan para revisión. No se inventan páginas, tasas ni cláusulas ausentes.

Usar fragmento rellena texto y referencia en la revisión existente. El operador coteja el original y completa lo que falta. Guardar interpretación vuelve a comprobar la evidencia y las condiciones protegidas del contrato. El cálculo económico continúa separado: simular → revisar → confirmar. La detección no modifica `late_fee_json`, canon, punitorios ni pagos, y no evita una rectificación documental si lo encontrado contradice datos protegidos.

Una extracción sin cláusula informa ausencia de detección, no una certificación de inexistencia jurídica. PDFs sin texto suficiente quedan bloqueados para revisión/OCR. El adaptador local opcional requiere `LATE_FEE_OCR=true`, Poppler (`pdftoppm`), Tesseract y datos de idioma español en PATH. No envía documentos a terceros; rasteriza en un temporal acotado y lo elimina al terminar. Aplica OCR como máximo a las primeras 20 páginas sin texto, con límites de tiempo por proceso. La propuesta OCR se etiqueta incierta y exige cotejo humano. Su texto y referencia se vuelven a verificar antes de aplicar; no permite reemplazar el resultado por una cláusula inventada. En esta Mac no están instalados esos binarios: se probaron la extracción PDF nativa, el adaptador con ejecución sustituida y la ruta de indisponibilidad; queda pendiente validar OCR nativo con los binarios/idioma de despliegue.

## Sin cláusula y política administrativa

El bloque Política interna permite revisión manual, sin punitorios convencionales, porcentaje fijo o BNA preciso como referencia informativa. La preferencia tiene motivo, confirmación y auditoría; no edita contratos existentes. La configuración general no puede cambiarla omitiendo esa operación.

La estimación usa el motor existente en una lectura consistente, devuelve `informational=true` y `exigible=false` y nunca se suma al Debe. No tiene una acción Aplicar. Sus convenciones de referencia se muestran expresamente. Un eventual interés con fundamento jurídico no contractual requiere revisión específica fuera de esta automatización; no se convierte la política administrativa en ese fundamento.

## Fuentes BNA, descubrimiento y cobertura offline

Fuentes oficiales consultadas:

- [BNA — Información al usuario financiero](https://www.bna.com.ar/Home/InformacionAlUsuarioFinanciero): cotización vigente y productos. No se usa para reconstruir tasas históricas ni se presume equivalencia con otras series.
- [Boletín Oficial — Primera Sección](https://www.boletinoficial.gob.ar/seccion/primera) y [edición 04/11/2026](https://www.boletinoficial.gob.ar/seccion/primera/20261104): índice oficial que identifica avisos del banco mediante título y enlaces reales. Se comprobó también la navegación por edición anterior; no se inventan IDs de avisos ni un endpoint de búsqueda.
- [Aviso BNA 350046, 04/11/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/350046/20261104): descargado directamente y validado con el parser. Cuatro intervalos de cartera general TNA vencida a 30 días, del 29/10/2026 hasta antes del 04/11/2026. La publicación no prueba por sí sola la tasa aplicable durante el día 4. SHA-256 del HTML observado: `5e85fb036266af57cadf4e5821ad49117a79e3aa0067310175cae40f7a1397a0`.
- [Aviso BNA 332108, 30/09/2025](https://www.boletinoficial.gov.ar/detalleAviso/primera/332108/20250930): fixture oficial anterior con cinco intervalos; cobertura del 23 al 29 de septiembre incluidos. Procedencia y hashes en `tests/fixtures/bna-cartera-20250930.provenance.json`.

Se preserva la modalidad soportada del Prompt 08: cartera general, préstamos, pesos, TNA vencida a 30 días, con base anual expresamente respaldada por el contrato. TEA, TEM, adelantadas, descubiertos y otros préstamos no se mezclan. Las publicaciones muestran cambios diarios y tramos que abarcan días sin cambio; no se presume una frecuencia fija ni un valor posterior al último límite oficial.

`sync.js` consulta índices oficiales fechados y descubre enlaces cuyo título identifica al BNA. Valida estructura y almacena URL/hash del índice y enlaces descubiertos en `late_fee_sync_state`. Descarga cada aviso sólo desde los dos dominios oficiales admitidos, sin redirecciones. Reutiliza el parser estricto y las tablas `late_fee_rate_sources` / `late_fee_rates`, conservando HTML completo, SHA, modalidad, intervalos, consulta y actor. Repetir una publicación no duplica; si cambia el HTML pero los intervalos económicos son idénticos, conserva la nueva evidencia sin duplicar tasas ni cambiar sus IDs. Contradicciones no sobrescriben historia. Últimos datos nuevos sólo avanza cuando se incorporan intervalos, no por un cambio de presentación del aviso.

El servidor inicia el servicio sin esperar la red. Un timer comprueba si corresponde consultar: cada 24 horas después de éxito, reintento tras una hora si hubo fallo. Un bloqueo de sincronización evita ejecuciones superpuestas. La acción manual permite repetir y elegir hasta 31 días pasados; por defecto consulta siete días. No hay un recolector completo de todas las ediciones desde el comienzo de la historia: se pueden incorporar rangos anteriores y avisos específicos. Una caída informa estado/error, conserva cobertura y no detiene contratos, pagos ni apertura del sistema.

Sin Internet, el motor usa exclusivamente las tasas persistidas. Puede calcular si cubren todos los días requeridos; si falta uno, identifica la primera fecha faltante y bloquea ese cálculo. Nunca extiende el último intervalo. La interfaz separa última consulta, última consulta exitosa, últimos datos nuevos y cobertura real. `coverage_complete=false` evita interpretar Actualizado como historia completa. Sincronizar tasas no recalcula punitorios, no crea deuda ni cambia pagos.

## Migración y archivos

Migración aditiva: `database/migrations/017_unified_finance.sql`. Añade responsabilidad y anulación lógica a `ledger_entries`, clasificación a cargos/reglas, `expense_operations` y `late_fee_sync_state`. No cambia importes históricos, no migra gastos a deuda, no convierte recurrencias antiguas ni recrea cuotas. La prueba de actualización construye 001–016, aplica 017 y coteja cuota y sobrepago histórico intactos.

| Archivos | Responsabilidad |
| --- | --- |
| `backend/src/modules/services/index.js` | Registro global, desglose, clasificación y operación compartida dentro de transacción externa. |
| `backend/src/modules/services/expenses.js` | Revisión conjunta, guardado atómico, anulación e idempotencia de gastos. |
| `backend/src/modules/late-fees/detection.js`, `ocr.js` | Extracción por página, propuestas y OCR local opcional. |
| `backend/src/modules/late-fees/policy.js`, `sync.js` | Referencia administrativa y sincronización oficial con estado persistente. |
| `backend/src/modules/late-fees/index.js`, `rates.js` | Evidencia OCR/exclusiones y admisión de los dos dominios oficiales. |
| `backend/src/app.js`, `server.js` | Rutas, snapshot consistente y arranque de consulta no bloqueante. |
| `frontend/src/pages/ServicesPage.jsx`, `App.jsx` | Registro unificado y navegación existente de Servicios. |
| `frontend/src/components/ExpenseModal.jsx` | Revisión de gasto/cargo y baja contable explícita. |
| `frontend/src/components/CompactPendingCollectionsPanel.jsx`, `pages/ResourcePage.jsx` | Tabla compacta, acciones y gastos anulables. |
| `frontend/src/components/InstallmentServicesModal.jsx`, `PaymentModal.jsx`, `TenantLiquidationModal.jsx` | Gestión compartida y desglose sin doble suma. |
| `frontend/src/components/LateFeeAssistance.jsx`, `LateFeeModal.jsx` | Detección, cobertura, actualización y propuesta informativa. |
| `frontend/src/styles.css` | Estilos localizados y responsive. |
| `tests/unified-finance.test.js`, `unified-finance-browser.test.js` | Integración nueva PostgreSQL y navegador con datos sintéticos. |
| `tests/support/synthetic-contract.js`, `late-fee-fixtures.js`, suites anteriores | PDFs sintéticos, multipágina y adaptación a nueva fecha/acciones. |
| `backend/scripts/check-private-artifacts.js`, `.gitignore`, `package.json` | Guardas de privacidad y suites completas. |
| `.env.example` | Habilitación opcional de OCR, sin tocar `.env`. |

No se modificaron motor IPC, fórmulas de saldo, fuente INDEC, WhatsApp, conciliación bancaria, comprobantes fiscales, logo ni migraciones anteriores. No se añadieron dependencias npm ni se cambió el lockfile.

## Validación y evidencia

| Comprobación | Resultado final |
| --- | --- |
| `pnpm test` con PostgreSQL aislado | **186 aprobadas, 0 fallos**: 161 anteriores + 25 nuevas. |
| `pnpm check` | Guarda de privacidad, sintaxis y compilación aprobadas. |
| `UX_BROWSERS=chrome,webkit pnpm test:browser` | **12 recorridos aprobados, 0 fallos**: 10 anteriores adaptados + 2 nuevos. |
| `git diff --check` | Sin errores. |

Entorno: PostgreSQL 17 en `/opt/homebrew/opt/postgresql@17/bin`, Node 22 y Playwright CLI instalado localmente. El runner creó y destruyó sus propios clusters y documentos sintéticos. No se utilizó la conexión de `.env` para las pruebas. Se verificó también la sintaxis de los cinco módulos nuevos de backend de gastos, detección, política, sincronización y OCR.

Las suites nuevas cubren alta y gestión compartida, clasificación, gasto sin obligación y borrador, atomicidad, monedas/IDs, unicidad, condonación/restauración, anulación con pagos/crédito, concurrencia, reintentos, snapshot obsoleto, rollback por auditoría, recurrencias, migración desde 016, página real de cláusula, ausencia documental/texto, OCR incierto, negación de intereses, política informativa, desconexión/reconexión, publicación repetida/contradictoria e independencia de pagos/IPC. Las suites anteriores mantienen renovación, cierre, límites contractuales y protección de sobrepagos.

Las pruebas de navegador ejercitan Servicios → cuota → condonación → Servicios → restauración, gasto/cargo conjunto, desglose en pago y liquidación, baja contable con cargo conservado y revisión del fragmento detectado sin modificar punitorios. Se miden scroll de tabla/tarjeta a 1366 × 768, posición de Cobrar y ancho de página móvil 390 × 844. Las capturas se revisaron visualmente. No se probó Windows, Edge ni Safari nativo por separado.

Evidencia local ignorada en `tmp/unified-finance-verification/{chrome,webkit}/`: `services-registry.png`, `expense-charge-preview.png`, `pending-1366.png`, `pending-mobile.png`, `liquidation-charges.png`, `detected-clause.png` y `evidence.json`. Logs finales junto a esas carpetas: `tests.log`, `browser.log`, `check.log`.

## Privacidad y remediación coordinada

Se retiraron del índice dos snapshots, dos PDFs y un archivo de metadatos. Se conservaron sus copias locales: no se borraron los documentos del usuario. `.gitignore` excluye `.playwright-cli/`, carpetas de contratos/temporales, dumps y metadatos del sistema. La auditoría del índice resultó en cero PDFs, cero snapshots de cartera y cero `.env` privado. `pnpm check` incorpora una guarda para evitar su reintroducción.

Las suites de importación/ciclo de vida ya no leen PDFs de la cartera. Generan su muestra sintética en el temporal aislado. Se sustituyeron también referencias residuales de esa muestra en los datos de prueba. El runner configura un banco y CBU ficticios exclusivamente dentro de su base temporal para que tampoco las liquidaciones o capturas hereden coordenadas bancarias de la instalación. Las capturas nuevas usan contratos y personas ficticios y quedan fuera de Git. Esta guarda de rutas no certifica que todo texto histórico esté libre de datos identificables.

El historial público anterior sigue conteniendo los archivos retirados; quitarlos del próximo árbol no los purga. Remediación pendiente, a coordinar con el titular según la [guía oficial de GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository): congelar publicaciones, respaldar referencias, inventariar también nombres antiguos, preparar un clon separado para `git-filter-repo --sensitive-data-removal --invert-paths` con las rutas privadas, revisar todos los refs y aprobar la sustitución remota. Después coordinar clones/forks y solicitar a GitHub revisión de referencias/cachés sensibles. Si aparecen credenciales, revocarlas antes. No se ejecutó reescritura, force push, cambio de visibilidad ni contacto externo. El informe no reproduce nombres ni datos de las partes.

## Límites y despliegue

- Auditoría con operador local; no hay sesiones autenticadas ni permisos por rol nuevos.
- OCR nativo requiere instalación y validación de binarios; heurísticas y OCR no certifican contenido jurídico. PDFs parcialmente ilegibles o cláusulas alternativas pueden requerir revisión específica.
- Interés no convencional con fundamento jurídico no contractual no se automatiza mediante una política interna.
- No hay historia BNA completa, inferencia de modalidades ni extensión de fechas sin evidencia. Un rango manual admite 31 días; la consulta automática revisa siete.
- Un gasto se vincula a una cuota en esta entrega. Repartir un comprobante entre varias cuotas requiere una operación de distribución revisada adicional; no se duplica por recurrencia.
- Anular un gasto conserva sus cargos. Corregirlos es una operación independiente con revisión de pagos/créditos; no hay devolución ni compensación automática.
- Se preservan vínculos históricos potencialmente repetidos; no se reescribe la cartera para corregirlos.
- Tokens propios del proceso: reinicio exige simular de nuevo; despliegues con varios procesos requieren afinidad o firma compartida segura.
- La exposición histórica de documentos requiere la remediación coordinada anterior.

Despliegue posterior, fuera del desarrollo:

1. Revisar cambios y 017; detener backend/watchers y respaldar base y documentos, guardando el backup fuera de Git.
2. Probar una copia controlada con 001–016 y cotejar saldos/pagos antes y después de 017. Ejecutar suites con `PG_BIN` y `PLAYWRIGHT_CLI` configurados.
3. Con autorización, aplicar explícitamente las migraciones a la conexión elegida (`node --env-file=.env backend/scripts/migrate.js`) y verificar 017 en `schema_migrations`.
4. Desplegar frontend y backend juntos, iniciar con `AUTO_MIGRATE=false`. Si se desea OCR, instalar/verificar herramientas e idioma antes de activar `LATE_FEE_OCR`.
5. Consultar cartera sin crear operaciones reales de prueba; cotejar gastos históricos, cero cargos nuevos por migración y los saldos previos.
6. Revisar cobertura BNA y estado de consulta. Probar primero con datos sintéticos la desconexión y las modalidades pactadas; no confundir éxito de descarga con cobertura del período.
7. Completar revisión de privacidad antes de publicar los cambios. El agente no publica ni reescribe historia automáticamente.

Rollback lógico: conservar esquema e historial; corregir efectos mediante operaciones auditadas. No volver a una versión que ignore la clasificación, omita cargos en saldos o cuente gastos anulados como vigentes. No borrar tablas ni pagos. Restaurar backup requiere coordinación de las operaciones posteriores.

**Durante Prompt 09 no se modificaron datos ni PDFs reales, no se ejecutaron migraciones reales y no se realizó commit ni push. Se detuvo el servidor de desarrollo conectado a la cartera antes de editar; no se reinició sobre un esquema real todavía sin 017.**
