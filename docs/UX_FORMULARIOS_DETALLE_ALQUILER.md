# Formularios de contratos y consulta del alquiler

Implementación del pedido 05, sobre `c4325da`. Trabajo de UX y compatibilidad de formularios; no hay cambios en fórmulas financieras, índices, cuotas, pagos, conciliación, estados contractuales ni migraciones.

## Cambios visibles

Los formularios de revisión, creación y edición comparten ahora una sola pregunta: **¿Cómo se actualiza el alquiler?**. No se presentan dos selectores que permitan elegir mecanismos contradictorios.

| Opción visible | Tipo al elegir la opción | Índice al elegir la opción |
| --- | --- | --- |
| Por IPC (INDEC) | `IPC` | `IPC` |
| Por ICL | `ICL` | `ICL` |
| Por índice CAC | `CUSTOM_INDEX` | `CAC` |
| Por porcentaje fijo | `FIXED_PERCENTAGE` | `null` |
| Según acuerdo de las partes | `MANUAL` | `null` |
| Otro mecanismo contractual | `CUSTOM_INDEX` | Nombre contractual, si corresponde |

Los pares antiguos compatibles se reconocen sin reescribirlos al abrir el formulario. Por ejemplo, un índice IPC con tipo antiguo vacío conserva su interpretación y los acuerdos antiguos pueden conservar `Acuerdo de partes`. Una combinación contradictoria requiere una elección explícita. No se sustituye un mecanismo desconocido por IPC.

La frecuencia ofrece 3, 4, 6 y 12 meses u otra cantidad entera positiva. En acuerdos manuales o mecanismos especiales se puede conservar una frecuencia no definida; no se obliga a inventar una condición contractual.

El porcentaje aparece solo para porcentaje fijo. Los mecanismos manuales o especiales permiten conservar sus condiciones. ICL, CAC, porcentaje fijo y otros mecanismos informan que requieren intervención manual; no se anuncia una automatización inexistente.

El mes de IPC aparece una sola vez y solo para IPC. El selector conserva los valores existentes: 0 y 1 siguen significando mes anterior, y 2 significa dos meses anteriores. Un valor antiguo mayor se identifica como condición existente, sin reducirlo silenciosamente.

En revisión, las opciones de intereses son legibles y conservan `NONE`, `FIXED_DAILY` y `BANK_ACTIVE_RATE` en el envío. El interés diario aparece únicamente para porcentaje diario fijo. Banco Nación informa que su cálculo no está implementado. No se modificó ese cálculo.

Los días del período de pago y el vencimiento tienen etiquetas distintas y explicación de su diferencia. Los días previamente registrados siguen visibles, aunque no coincidan. Cuando no hay período registrado puede indicarse uno de forma explícita. La interfaz no deriva el vencimiento desde el último día del período ni inventa un vencimiento faltante en la revisión o edición.

Las coincidencias documentales y el resumen del mecanismo en Contratos también muestran etiquetas legibles.

## Cobros Pendientes

El importe es un botón discreto, accesible con teclado y separado del lápiz de edición. Los indicadores de la celda son breves. Se eliminó el `<details>` de `IpcStatus`, por lo que consultar un importe no expande la fila ni agrega columnas.

La ventana **Detalle del alquiler — [mes y año]** reutiliza `Modal` y presenta:

- Importe aplicado, propiedad, contrato e inquilino.
- Canon inicial y canon contractual persistido; una corrección manual se identifica por separado.
- Mecanismo, frecuencia y mes de IPC utilizado.
- Aumentos cronológicos del cálculo guardado de esa cuota, importes y coeficientes acumulados.
- Períodos base y de comparación, niveles y fuente oficial, cuando están registrados.
- Avisos de importe provisional, datos faltantes y conciliación histórica pendiente.
- Próximo período de ajuste cuando puede determinarse con condiciones fiables y no hay conciliación pendiente.
- Versiones correspondientes exclusivamente a esa cuota.

Los índices ausentes no se convierten en cero ni se reconstruyen por suposición. Los contratos sin IPC muestran sus condiciones y el aviso de intervención manual, sin presentar un historial de INDEC. Si falla la consulta de versiones se conserva el detalle disponible, se explica el problema y se ofrece reintentar.

El contenido usa desplazamiento interno y una columna en pantallas pequeñas. Los índices técnicos pueden desplazarse horizontalmente en celulares. Escape y los botones de cierre funcionan sin cambiar datos; el foco vuelve al control que abrió la ventana, también en WebKit.

## Adaptación controlada del backend

Crear y editar contratos antes ignoraban parte de los campos de mecanismo y porcentaje. Se añadieron esos campos al mapeo de las operaciones existentes, junto con los días del período y las condiciones textuales. No se cambió cómo se generan ni actualizan las cuotas.

En la revisión se distingue un índice omitido de un `null` explícito. Esto es necesario para que elegir porcentaje fijo o acuerdo manual no conserve por error un IPC anterior. El porcentaje cero también se conserva como dato.

La lectura de Cobros Pendientes incluye ahora el contexto contractual necesario para la consulta. La ventana utiliza `calculation_json` de la cuota y el endpoint existente `GET /api/contracts/:id/adjustments`, filtrando por ID de cuota. No se agregó un endpoint ni una descarga externa de índices al abrirla.

La edición económica IPC conserva la simulación y confirmación existentes. No se modificaron los módulos IPC, rent, money ni la conciliación histórica.

## Archivos

| Archivo | Responsabilidad |
| --- | --- |
| `frontend/src/utils/contract-options.mjs` | Catálogo, correspondencia compatible y próximo período para presentación. |
| `frontend/src/components/ContractTermsFields.jsx` | Campos compartidos de mecanismo, frecuencia, mes de IPC, período y demora. |
| `frontend/src/components/RentDetailModal.jsx` | Consulta del importe y versiones guardadas. |
| `frontend/src/components/ContractEditModal.jsx` | Uso de campos compartidos manteniendo la simulación. |
| `frontend/src/components/RecordModal.jsx` | Creación con el mismo catálogo y envío compatible. |
| `frontend/src/components/FormField.jsx` | Asociación accesible de etiquetas y ayudas. |
| `frontend/src/components/Modal.jsx` | Cierre nativo y restitución del foco. |
| `frontend/src/components/IpcStatus.jsx` | Indicadores compactos sin contenido desplegable. |
| `frontend/src/pages/ResourcePage.jsx` | Revisión simplificada y acceso a la consulta desde el importe. |
| `frontend/src/styles.css` | Estilos acotados a importe y detalle. |
| `backend/src/app.js` | Mapeo de campos existentes y contexto adicional de lectura. |
| `backend/src/modules/imports/contract-parser.js` | Índice explícito vacío, porcentaje cero y condiciones textuales. |
| `tests/contract-ux.test.js` | Catálogo, compatibilidad, persistencia y preservación económica. |
| `tests/contract-ux-browser.test.js` | Recorridos Chrome/WebKit de formularios y consulta. |
| `tests/p0-browser.test.js` | Selectores adaptados a la interfaz simplificada y a la equivalencia del mes anterior. |
| `tests/app.test.js`, `tests/lifecycle.test.js` | Localización de la copia de prueba renombrada, sin restaurar PDFs eliminados. |
| `tests/run-isolated.js`, `package.json` | Inclusión de las pruebas nuevas. |
| `docs/UX_FORMULARIOS_DETALLE_ALQUILER.md` | Este informe. |

## Verificación

- `pnpm test`: **95 pruebas aprobadas**, incluidas las 91 anteriores y 4 nuevas de compatibilidad.
- `pnpm check`: sintaxis, validaciones existentes y compilación frontend aprobadas.
- `UX_BROWSERS=chrome,webkit pnpm test:browser`: **4 pruebas aprobadas**: nuevos recorridos Chrome y WebKit, además de las regresiones IPC y reimportación existentes.
- `git diff --check`: sin errores.

Se usó PostgreSQL temporal con `PG_BIN=/opt/homebrew/opt/postgresql@17/bin` y el Playwright CLI instalado, indicado con `PLAYWRIGHT_CLI`. Para repetir WebKit debe estar instalado en las herramientas de prueba (`playwright-cli install-browser webkit`); no se agregó una dependencia al proyecto. Sin `UX_BROWSERS`, el recorrido nuevo usa Chrome.

Los casos nuevos verifican las opciones legibles, porcentaje condicional, ausencia de rezago duplicado, conservación del valor antiguo 0, intervalos distintos del vencimiento, frecuencia especial y manual no definida, contratos anteriores y edición sin cambios económicos. Los formularios se comprueban contra los valores enviados, y la compatibilidad de creación y revisión también se prueba con escrituras reales en PostgreSQL aislado.

En la consulta se verifican teclado, Escape, restitución de foco, apertura independiente del lápiz, altura de fila estable, índice pendiente, corrección manual, histórico sin conciliación, contrato sin IPC, ausencia de aumentos y error recuperable al leer versiones. Las capturas incluyen 1365 × 960 y 390 × 844.

Se compararon completos los registros de cuotas, pagos y versiones antes y después de las consultas y de una edición sin cambios económicos: permanecieron iguales. No hubo solicitudes externas de datos al consultar el detalle; las fuentes tipográficas que el proyecto ya utilizaba son recursos de la página, ajenos a esta consulta.

## Evidencia

En `tmp/contract-ux/chrome/` y `tmp/contract-ux/webkit/`:

- `review-fixed.png`: ajuste único, porcentaje y frecuencia especial.
- `create-contract.png`: mismo criterio en creación.
- `rent-ipc-desktop.png`: detalle con fuente, índices y versiones.
- `rent-manual-override.png`: importe manual separado del contractual.
- `rent-provisional.png`: período oficial faltante.
- `rent-ipc-mobile.png`: ventana móvil.
- `evidence.json`: comprobaciones de accesibilidad, red y preservación económica.

Los logs finales están en `tmp/contract-ux/tests.log`, `browser.log` y `check.log`. Esos artefactos quedan fuera del control de versiones.

## Límites y puesta en uso

Safari nativo no pudo automatizarse: `safaridriver` informó que **Allow remote automation** está desactivado. No se cambió esa preferencia. Se probó WebKit 26.6 en esta Mac, además de Chrome; esto no se presenta como una prueba realizada sobre Safari 27.2 nativo. Edge tampoco se ejecutó por separado. La comprobación específica en esos navegadores reales queda pendiente.

No hay migraciones ni dependencias nuevas del proyecto. Para poner en uso las pequeñas adaptaciones del servidor es necesario reiniciar el backend con el esquema que ya exige el proyecto y servir el frontend compilado del mismo cambio. No se reinició ni migró la base real durante esta tarea.

Se conservaron las eliminaciones y el PDF renombrado que estaban en el espacio de trabajo al comenzar. No se modificaron archivos PDF, `.env`, `.env.example`, logo, paleta, sidebar, fuentes, migraciones, recibos, WhatsApp o los cálculos de punitorios. No se hicieron commits ni push.
