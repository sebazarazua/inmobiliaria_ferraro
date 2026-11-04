# Punitorios Banco Nación e integridad financiera — Prompt 08

Fecha: 4 de noviembre de 2026. Base de implementación `e720a2d`, sincronizada con origin/main al comenzar. Al retomar el trabajo, los cambios ya estaban incluidos en el commit `e937440`. El agente no realizó commits ni push, despliegues, migraciones o cambios de datos reales.

## Resultado y alcance preciso

Se reemplazó el cálculo de punitorios del navegador por un motor independiente en el backend. Se conservan los datos originales del contrato y los importes anteriores; toda actualización económica requiere simulación, motivo y confirmación.

Banco Nación tiene soporte **acotado a una modalidad identificada y a los intervalos oficiales incorporados**. No se considera resuelta una cláusula que solamente diga tasa activa Banco Nación, ni se dispone de una serie completa para cualquier fecha. Descubiertos, otras modalidades y períodos sin evidencia quedan bloqueados. No se elige una tasa por similitud ni se completa el historial con estimaciones.

También se corrigieron:

- Sobrepago accidental en pagos individuales, distribuidos y aumento de pago parcial manual. El registro de un excedente exige una operación distinta con crédito visible y confirmación.
- Liquidación con servicios individuales y subtotal en la misma lista de cargos. Ahora Servicios netos es el único concepto que integra esa tabla; el desglose está separado como información incluida.

## Investigación y fuentes oficiales

1. [BNA — Información al usuario financiero](https://www.bna.com.ar/Home/InformacionAlUsuarioFinanciero). Distingue cotizaciones nominales/efectivas y enlaza productos diferentes. Sirve para identificar modalidades; su cotización vigente no reconstruye un período histórico.
2. [BNA — tasas activas, publicación 3451](https://www.bna.com.ar/BackOffice/dataBase/tasas_cart_3451.pdf) y [publicación 4017](https://www.bna.com.ar/BackOffice/dataBase/tasas_cart_4017.pdf). Se inspeccionó su disposición visual para distinguir cartera general, adelantos y clases de descubierto. Son cuadros de vigencias; no se infiere que prueben cada día posterior a una fecha.
3. [BNA en el Boletín Oficial — aviso 332108, 30/09/2025](https://www.boletinoficial.gov.ar/detalleAviso/primera/332108/20250930). La tabla identifica plazos y modalidades. La extracción soportada toma únicamente la columna de 30 días bajo TNA vencida de cartera general (préstamos), no las columnas TEA/TEM ni la tabla adelantada.
4. [BNA en el Boletín Oficial — aviso 332828, 14/10/2025](https://nuevaweb.boletinoficial.gob.ar/detalleAviso/primera/332828/20251014). Se consultó para contrastar la estructura de intervalos. No se mezclan condiciones de otros préstamos o descuentos que aparecen en el mismo aviso.

Se descargó el aviso 332108 y se verificó el parser contra su HTML real. La prueba versionada guarda un extracto mecánico de encabezados y cinco filas pertinentes, con enlace, fecha y hashes del contenido original/extracto en `tests/fixtures/bna-cartera-20250930.provenance.json`. Los datos de esa prueba son oficiales, no una curva sintética. Los contratos, personas, pagos y PDFs de las pruebas sí son ficticios.

Los intervalos se utilizan como [desde, hasta): fechas de cambio contiguas, sin extender la última fecha final. La cobertura de esa evidencia de prueba es del 23 al 29 de septiembre de 2025 incluidos. El día 30 se bloquea expresamente al no contar con el siguiente intervalo incorporado.

La operación de incorporación descarga desde la ruta HTTPS admitida del Boletín Oficial, sin redirecciones ni HTML/tasas enviados por el cliente. Conserva cuerpo completo, SHA-256, URL, fecha de consulta y actor. Una estructura no reconocida, fallo de consulta o contradicción con tasas registradas detiene la importación. No cambia cuotas ni ejecuta recálculos automáticos.

## Modalidades y condiciones soportadas

| Aspecto | Soporte / bloqueo |
| --- | --- |
| Porcentaje diario fijo | Porcentaje que consta en el PDF y coincide con el dato protegido. Hasta seis decimales de porcentaje. |
| BNA | Cartera general (préstamos), pesos, TNA vencida a 30 días, con modalidad exacta respaldada en el contrato. |
| Base anual | 365 o 360 si el documento la expresa. No se deriva de una TNA genérica. |
| Capital | Saldo impago del canon del período. No integra servicios, IVA, intereses previos ni capitalización. |
| Pagos | Primero a capital, al inicio del día de su fecha registrada, si la cláusula respalda esa imputación. |
| Acumulación | Simple, diaria. Se bloquean capitalización, interés compuesto y multiplicadores no soportados. |
| Inicio | Día siguiente al vencimiento/gracia, o primer día del mes condicionado a haber superado el vencimiento/gracia, según evidencia. |
| Corte | Día civil incluido, revisado expresamente. No se admite un corte futuro. |
| Plazo | Hasta diez años por simulación; períodos mayores requieren tratamiento específico. |

La revisión requiere PDF original administrado, vínculo con el contrato, SHA coincidente, fragmento real extraído, página/cláusula, motivo y confirmación. Se verifica respaldo textual de modalidad, porcentaje, capital, imputación, periodicidad, inicio y acumulación; para BNA, también modalidad y base anual. El fragmento debe precisar imputación al inicio del día y corte incluido. Los parámetros adicionales no soportados se rechazan.

La interpretación se guarda versionada aparte. No sobrescribe `contracts.late_fee_json`, el documento ni el canon. Si la modalidad o el porcentaje contradicen los datos protegidos, se requiere el circuito documental correspondiente; el nuevo flujo no permite eludirlo. La revisión técnica no certifica firmas ni sustituye interpretación jurídica. Si el texto es ambiguo, combina alternativas/topes no soportados o el PDF no tiene texto extraíble, se bloquea. También se comprueban moneda y vigencia de la cuota antes de calcular.

También se bloquea el cálculo con alquiler provisional/IPC sin conciliar, descuento general cuya imputación a capital no está identificada o pago parcial manual sin cronología. No se asigna una fecha ficticia a `manual_partial_amount` ni se descuenta nuevamente del saldo. Otras bases de capital necesitan una extensión revisada, no una suposición.

## Fórmulas, fechas y redondeo

Para cada día civil d con capital impago:

```text
Capital(d) = máximo(0, alquiler aplicado del período − pagos imputables hasta d)
Fijo: interés = suma[Capital(d) × porcentaje diario / 100]
BNA:  interés = suma[Capital(d) × TNA oficial(d) / (100 × base anual contractual)]
Punitorio neto = importe calculado o registrado − condonación conocida
```

La TNA es una cotización nominal; el motor no la transforma en TEA ni capitaliza intereses. Se corta un tramo cuando cambia tasa o capital. Fechas civiles y desplazamientos usan UTC, sin horas locales ni división de milisegundos para contar días de mora. Una cuota pagada deja de devengar sobre capital desde la fecha de imputación; no se cobran intereses sobre su crédito.

Las operaciones monetarias usan BigInt, centavos y fracciones exactas. Se redondea mitad hacia arriba una sola vez al final, no cada día/tramo. El cálculo conservado incluye versión del motor, revisión/evidencia, fórmula, numerador/denominador, capitales, pagos computados, tasas, días, fechas, URL y hash de cada fuente.

Ejemplos verificados: capital 100.000, tasa diaria 0,10 %, siete días → 700. Un pago de 40.000 al inicio del tercer día reduce el cálculo a 500. Con las cinco filas oficiales del aviso citado, el ejemplo BNA de siete días arroja 1.025,95. No se aplica ese ejemplo a ningún contrato real.

## Simulación, condonaciones e historial

La ventana Punitorios muestra el importe calculado/registrado, condonado y neto. Permite revisar cláusula, consultar PDF/cobertura, indicar corte y motivo, simular y comprobar anterior/nuevo/diferencia, días, tramos, tasas y saldo. Aplicar exige otra confirmación explícita.

La simulación no escribe cuotas ni pagos. Su token HMAC de 15 minutos vincula propuesta, contrato, cuota, pagos, revisión y tasas. Aplicar revalida evidencia y snapshot bajo el bloqueo financiero común. Cambios intermedios o un token de otro flujo no autorizan la modificación.

Condonar total o parcialmente conserva el bruto y cálculo original. El importe condonado es absoluto y reemplaza al anterior; no se acumula como otro descuento. Restaurar retira esa condonación conocida mediante otra operación auditada. Una condonación superior al bruto o al nuevo cálculo se bloquea para revisión separada. Si una condonación antigua perdió su bruto, no se inventa el importe para restaurarla.

Cada cambio económico registra versión, fecha, motivo, actor disponible, antes/después, fórmula y fuentes. Un UUID repetido devuelve el resultado anterior; una nueva solicitud con cálculo equivalente no duplica versiones. El mismo UUID con propuesta distinta se rechaza. Un fallo revierte importe, estado, auditoría e idempotencia.

Cuotas sustituidas/cerradas no se modifican. La renovación conserva cuotas con historial de punitorios; la eliminación de un contrato con revisiones/historial queda bloqueada para conservar evidencia. Los contratos inactivos no reciben aumentos de obligación por este circuito.

## Sobrepagos y créditos

El registro normal verifica el saldo bajo bloqueo, justo antes de insertar. Si el pago lo supera, rechaza todo. Distribuir también rechaza un monto superior al total disponible, conservando su transacción única. No se registra una parte mientras se presenta un mensaje de éxito por el total solicitado. Aumentar un pago manual por encima de la deuda tampoco evita esta protección.

Registrar excedente como crédito es otra operación, sobre una cuota concreta: motivo → revisión del saldo/dinero recibido/crédito anterior y resultante → confirmación → registro íntegro de la transferencia y auditoría. Requiere UUID, token vigente y confirmación; `allow_excess` o `confirmed` en el endpoint normal no bastan. No convierte moneda, distribuye créditos ni devuelve fondos.

Los pagos recibidos permanecen intactos. Se conservan reintentos con el esquema anterior de claves, incluso para sobrepagos históricos. Dos pagos normales simultáneos no crean un crédito accidental; dos aplicaciones idénticas de un crédito no duplican la transferencia ni el historial.

## Liquidación

La tabla económica contiene una sola fila Servicios netos. El desglose informativo está en un bloque aparte, con original, perdonado y neto incluido por servicio. No comparte la lista de conceptos sumables ni aparenta otro cargo. Total, pagos y saldo siguen llegando del backend.

Se conservaron imprimir/guardar PDF. El recorrido prueba la generación del HTML de impresión y su desglose mediante una ventana simulada, sin guardar o modificar PDFs del usuario. No se implementan comprobantes fiscales.

## Migración y archivos

Nueva migración aditiva `016_late_fees_financial_integrity.sql`:

- Cuotas: bruto conocido nullable, condonación conocida inicialmente cero y cálculo/hash nullable. No reescribe `late_fee_amount` ni reconstruye datos antiguos.
- `late_fee_reviews`: versiones de interpretación/evidencia, motivo y actor.
- `late_fee_rate_sources` y `late_fee_rates`: publicaciones verificadas e intervalos históricos por producto.
- `late_fee_history` y `late_fee_operations`: versiones económicas e idempotencia sin cascadas destructivas.

| Archivos | Cambio |
| --- | --- |
| `backend/src/modules/late-fees/common.js` | Fechas civiles, importes, firmas, hashes y actor. |
| `backend/src/modules/late-fees/rates.js` | Modalidad específica, descarga/validación de avisos y persistencia de evidencia. |
| `backend/src/modules/late-fees/engine.js` | Motor diario simple con pagos, tasas históricas y redondeo exacto. |
| `backend/src/modules/late-fees/index.js` | Revisión documental, simulación/aplicación, condonaciones e historial. |
| `backend/src/modules/late-fees/overpayment.js` | Revisión firmada de excedentes y crédito resultante. |
| `backend/src/app.js` | Endpoints, protección de pagos/PATCH, creación de condición inicial y preservación de historial en ciclo de vida. |
| `frontend/src/components/LateFeeModal.jsx` | Gestión diferenciada de punitorios y evidencia. |
| `frontend/src/components/PaymentModal.jsx` | Flujo de excedente con revisión y confirmación. |
| `frontend/src/components/TenantLiquidationModal.jsx` | Concepto único y desglose separado de servicios. |
| `frontend/src/components/ContractTermsFields.jsx`, `RecordModal.jsx` | Conservación de modalidad inicial y mensajes de alcance/revisión. |
| `frontend/src/pages/ResourcePage.jsx`, `styles.css` | Acceso al modal; retiro del cálculo de mora del navegador y estilos locales. |
| `tests/late-fees.test.js`, `late-fees-browser.test.js`, `support/late-fee-fixtures.js` | Casos nuevos aislados y PDFs ficticios con cláusulas precisas/ambiguas. |
| `tests/fixtures/bna-cartera-20250930.*` | Extracto oficial y procedencia verificable. |
| `tests/app.test.js`, `ipc.test.js` | Adaptación de pruebas: el dato histórico se conserva y los créditos nuevos requieren operación explícita. |
| `tests/run-isolated.js`, `package.json` | Incorporación de pruebas a suites completas. |
| `docs/API.md`, este informe | Contratos de API, fórmulas, fuentes y despliegue. |

No se modificaron motor IPC, fuente INDEC, módulo de servicios/su aritmética, WhatsApp, recibos fiscales, conciliación bancaria, PDFs del usuario, branding, navegación general, `.env` ni migraciones anteriores. Sin dependencias nuevas.

## Validación

- `pnpm test`: **161 aprobadas, 0 fallos** (136 anteriores + 25 casos nuevos).
- `pnpm check`: comprobaciones y compilación aprobadas.
- `UX_BROWSERS=chrome,webkit pnpm test:browser`: **10 recorridos aprobados, 0 fallos** (8 anteriores + mora en ambos navegadores).
- `git diff --check`: sin errores.

Todos los datos se probaron en PostgreSQL temporal creado/destruido por el runner. La prueba de actualización construye el esquema 001–015 con cuota, punitorio y sobrepago históricos, aplica 016 y verifica importes/pagos idénticos, con cero cálculos nuevos. No utiliza la base real.

Casos nuevos: tasa fija; tabla oficial por plazo/modalidad; cambios de tasa y capital; datos/evidencia ausentes o contradictorios; corte/gracia/primer día; pago parcial/total/crédito; redondeo final; condonación/restauración; canon provisional/descuento/manual sin imputación; cierre/sustitución; concurrencia e idempotencia; tokens obsoletos; rollback; servicios/IPC independientes; sobrepago normal/distribuido/manual; excedente confirmado; claves y cartera históricas.

Chrome y WebKit en esta Mac, escritorio 1440 × 1000 y móvil 390 × 844. Tras el ajuste móvil se repitieron y aprobaron los dos recorridos completos de mora, con comprobación del ancho interno del formulario. No se ejecutaron Windows/Edge/Safari nativo por separado. Se revisaron visualmente las capturas y se corrigió un desborde interno del formulario en móvil; la tabla de tasas conserva su desplazamiento propio. La prueba comprueba también el ancho del contenido, además del diálogo. Los recorridos verifican lectura → API → dato persistido → saldo mostrado y la ausencia de cambios en canon, IPC, servicios y movimientos contables.

Evidencia en `tmp/late-fees-verification/chrome/` y `webkit/`: `fixed-daily-preview.png`, `forgiveness-history.png`, `liquidation-services-separated.png`, `explicit-credit-preview.png`, `bna-historical-preview.png`, `bna-rates-detail.png`, `missing-official-rate-blocked.png`, `punitorios-mobile.png`, `evidence.json`. Logs: `tests.log`, `browser.log`, `check.log` en `tmp/late-fees-verification/`. Artefactos ignorados por Git.

## Límites y despliegue

No hay un recolector completo de la historia BNA ni selección automática de modalidades. Los períodos sin avisos incorporados y las cláusulas ajenas al alcance quedan pendientes de revisión. El sistema no certifica jurídicamente la interpretación. El actor es el operador local porque la aplicación aún no tiene sesiones autenticadas/roles.

Tokens de un proceso: reiniciar obliga a simular de nuevo; varios procesos requieren compartir su firma de forma segura o afinidad de sesión. No hay traslado o devolución automática de créditos. No se implementa una reapertura contable que evite el bloqueo de períodos cerrados.

Despliegue, con autorización posterior:

1. Detener instalación/watchers y respaldar base y documentos.
2. Revisar 016 y probar una copia controlada de la cartera; conservar un cotejo de pagos, saldos y punitorios.
3. Ejecutar las suites anteriores con los binarios configurados (`PG_BIN` y `PLAYWRIGHT_CLI`).
4. Aplicar migraciones revisadas explícitamente a la conexión correcta, por ejemplo `node --env-file=.env backend/scripts/migrate.js`, y verificar 016 en `schema_migrations`.
5. Desplegar frontend/backend juntos con `AUTO_MIGRATE=false`. No iniciar un watcher que aplique migraciones sin revisión.
6. Consultar saldos históricos antes de cargar tasas o aplicar punitorios reales. Incorporar únicamente avisos oficiales y revisar cláusula/cobertura para cada cálculo.
7. Verificar pago normal, revisión de crédito y liquidación. No usar datos reales de prueba para validar el despliegue.

Rollback lógico: conservar esquema/historial y revertir el efecto económico mediante operaciones auditadas. No borrar pagos, fuentes ni versiones. Volver a una versión que admita sobrepagos implícitos o edite punitorios sin revisión restituiría los riesgos corregidos; un backup solo debe restaurarse de forma coordinada para conservar operaciones posteriores.

**No se aplicaron migraciones, punitorios, pagos ni tasas a la base real. No se modificaron datos ni PDFs reales. El agente no realizó commits ni push.**
