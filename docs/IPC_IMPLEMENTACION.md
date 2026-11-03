# Motor IPC: implementación, verificación y despliegue

Fecha: 3 de noviembre de 2026. Implementación sobre la arquitectura Node.js + pg + PostgreSQL + React existente. No se agregaron dependencias de ejecución.

## Resultado y límites de la verificación

Se verificaron cálculos, escrituras reales en PostgreSQL temporal, API HTTP, conciliación y navegador. La fuente directa de INDEC devolvió 118 niveles mensuales, desde diciembre de 2016 hasta septiembre de 2026. El índice de septiembre es 12514,1508; la variación derivada es aproximadamente 1,9336102 %, que INDEC publica redondeada a 1,9 %.

La base configurada en `.env` devolvió `ECONNREFUSED` en una conexión de solo lectura. No se ejecutaron migraciones, conciliaciones ni modificaciones de pagos sobre esa base. Los resultados históricos de este informe pertenecen a datos de prueba aislados; falta simular y revisar los registros de la instalación real cuando esté accesible.

## Archivos

Backend:

- `backend/src/lib/calendar.js`: fechas ISO y objetos Date de pg; meses consecutivos; vencimientos al último día válido.
- `backend/src/lib/money.js`: aritmética decimal con BigInt, redondeo half-up y saldos.
- `backend/src/modules/ipc/index.js`: cálculo puro acumulado, validaciones, rezago y último tramo válido.
- `backend/src/modules/ipc/source.js`: CSV INDEC prioritario y CSV gubernamental alternativo; validación de niveles y continuidad.
- `backend/src/modules/ipc/store.js`: persistencia/versiones, actualización manual/automática, control de consultas, conservación offline.
- `backend/src/modules/rent/index.js`: generación, simulación, conciliación y trazabilidad de cuotas.
- `backend/src/modules/imports/contract-parser.js`: generación mediante el servicio común; preview completo; conservación de cláusula y revisión de ambigüedades.
- `backend/src/app.js`: lecturas persistidas; endpoints IPC; edición revisada de condiciones; cobros transaccionales; correcciones manuales explícitas.
- `backend/src/modules/whatsapp/index.js`: importes persistidos, conceptos del saldo y centavos.
- `backend/src/server.js`: actualización periódica al inicio y durante la ejecución.
- `backend/src/database/index.js`, `backend/scripts/migrate.js`: migración controlada y separación de archivos de prueba.

Base de datos:

- Nueva migración aditiva `database/migrations/013_ipc_calculation_and_reconciliation.sql`. No modifica migraciones anteriores ni recalcula datos financieros existentes.
- Tablas: `ipc_index_versions`, `ipc_indices`, `ipc_refresh_state`, `rent_adjustment_history`.
- Columnas nuevas en `contracts` para cláusula/revisión y en `installments` para canon contractual, original, override, incorporación y versión del cálculo.

Frontend:

- Componentes nuevos: `IpcAdministration.jsx`, `IpcStatus.jsx`, `ContractEditModal.jsx`.
- Integración en `SettingsPage.jsx`, `ResourcePage.jsx`, `DashboardPage.jsx`, `PaymentModal.jsx` y `RecordModal.jsx`.
- `utils/format.js`: importes con centavos.
- `styles.css`: estilos acotados a información y conciliación IPC, conservando el diseño existente.

Verificación y documentación:

- `tests/run-isolated.js`, `tests/require-isolated.js`, `tests/ipc.test.js`, `tests/ipc-live.test.js`, `tests/ipc-browser.test.js`.
- `tests/app.test.js`: aislamiento obligatorio y expectativa de importación corregida.
- `tests/fixtures/ipc-national-official.csv` y su procedencia JSON.
- `package.json`, `.env.example`, `README.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/ARCHITECTURE.md` y este informe.

## Reglas económicas

Se usa el nivel general nacional con base diciembre de 2016=100. Las variaciones mensuales se derivan para información; el canon se calcula con niveles oficiales, no acumulando porcentajes mensuales redondeados.

Para inicio S, frecuencia F, período P y rezago R:

```text
desplazamiento = max(1, R o 0)
ajustes = floor(meses(S, P) / F)
mes_efectivo = S + ajustes × F
base = S - desplazamiento
comparación = mes_efectivo - desplazamiento
canon = canon_inicial × nivel(comparación) / nivel(base)
```

Se redondea half-up a centavos una vez, sobre el resultado acumulado desde el canon inicial. No se redondean aumentos intermedios. Los índices se escalan a 10 decimales para la operación entera exacta.

Convención confirmada: 0/ausente conserva el mes anterior; 1 usa el mes anterior; 2 usa dos meses anteriores. Ambos extremos se desplazan por igual. Se guarda la cláusula original; un texto ambiguo requiere confirmación humana y no se aplica automáticamente. Los contratos existentes no se reinterpretan ni se incorporan automáticamente.

Si falta el siguiente dato, se conserva el último tramo calculable y se identifica el período faltante. La cuota continúa provisional. Si nunca hubo un ajuste calculable, el canon inicial sigue siendo el último válido.

## Fuente e integración

Primaria: https://www.indec.gob.ar/ftp/cuadros/economia/serie_ipc_divisiones.csv

Alternativa oficial: https://infra.datos.gob.ar/catalog/sspm/dataset/145/distribution/145.3/download/indice-precios-al-consumidor-nivel-general-base-diciembre-2016-mensual.csv

Se verificó la API de Series de Tiempo utilizada anteriormente; su serie de variaciones llegaba a agosto cuando INDEC ya tenía septiembre. Se eligieron niveles en CSV oficiales para evitar ese atraso y la reconstrucción histórica desde tasas. No se identificó una API JSON directa de INDEC más adecuada que su publicación CSV para esta integración.

Se validan columnas, fechas, valores positivos, orden, duplicados y continuidad antes de escribir. No se aceptan nulos como inflación cero. Una respuesta más antigua que la almacenada se descarta. La alternativa puede completar períodos faltantes, pero no sustituye niveles ya obtenidos directamente de INDEC.

Timeout por fuente: 20 segundos. Sin Internet, los cálculos y pagos siguen usando PostgreSQL. El estado guarda el último error; las versiones válidas no se pierden. La consulta está protegida por un advisory lock compartido entre procesos; no mantiene filas financieras bloqueadas durante Internet.

El proceso comprueba al iniciar y cada hora si pasaron 12 horas desde el último intento de descarga. La detección de un dato nuevo puede demorar hasta ese intervalo más la espera al próximo tick. La consulta manual tiene separación mínima de 60 segundos. Después se recalculan únicamente las cuotas ya incorporadas al motor.

## Reconstrucción histórica y pagos

Las cuotas anteriores quedan con `ipc_managed=false` y conservan sus importes. Esto es una protección de despliegue, no un congelamiento definitivo: la conciliación incluye todas las cuotas no sustituidas, incluso pagadas, vencidas y futuras.

En Configuración se selecciona contrato o conjunto, se simula y se revisan importe anterior, contractual, efectivo, pagos recibidos y saldo/crédito. La aplicación exige token vigente, motivo y confirmación de cláusulas para incorporar registros anteriores. Cambios de pagos, condiciones o índices invalidan el token. Una cuota bloqueada impide aplicar el lote; se puede revisar por contrato.

Al aplicar se conserva `original_expected_amount`, se registra el nuevo canon y una versión de su explicación. Ningún pago se borra, cambia o duplica. El estado se concilia con la obligación: un subpago queda parcial; un sobrepago conserva saldo negativo en la simulación. No se genera un segundo crédito ni una segunda obligación por la misma diferencia.

Las correcciones manuales identificadas se conservan como `rent_override_amount`. Los acuerdos antiguos sin identificación estructurada requieren revisar el PDF y el importe anterior antes de aplicar. Una condonación identificada se respeta.

El cobro inserta la transferencia y cambia el estado en una transacción. No descarga índices, recalcula alquileres ni borra pendientes. Una cuota provisional no queda definitivamente pagada por recibir una transferencia. Las publicaciones siguientes actualizan su obligación y estado conservando el dinero recibido.

## Ejemplos verificados

Contrato A: enero de 2026, $500.000, IPC trimestral, rezago 0/1.

| Meses | Antes | Correcto persistido |
|---|---:|---:|
| Enero–marzo | 500.000,00 | 500.000,00 |
| Abril–junio | 500.000,00 | 547.211,45 |
| Julio–septiembre | 500.000,00 | 584.229,63 |
| Octubre–diciembre | 500.000,00 | 618.204,30 |

Contrato B: noviembre de 2025, $400.000, IPC trimestral, 24 meses, importado con antigüedad.

| Meses | Correcto persistido |
|---|---:|
| Noviembre 2025–enero 2026 | 400.000,00 |
| Febrero–abril 2026 | 433.701,80 |
| Mayo–julio 2026 | 473.271,69 |
| Agosto–octubre 2026 | 502.980,71 |
| Noviembre 2026 | 502.980,71 provisional; falta octubre |

No se inventó el IPC de octubre de 2026.

Simulación histórica en navegador: seis cuotas de $500.000 registradas al canon inicial y una transferencia de $500.000 para abril. La diferencia de canon de abril–junio fue $141.634,35; abril mostró saldo $47.211,45. Se aplicó la conciliación revisada y se cobró ese saldo en la base aislada: quedaron los dos pagos originales de esa prueba, $500.000 y $47.211,45. Una posterior modificación contractual revisada conservó esos pagos y generó otra versión de la obligación.

En la prueba INDEC real, el contrato B generó 24 cuotas; agosto persistió $502.980,71 y la API devolvió el mismo número. Un pago de $400.000 para abril dejó $33.701,80 de saldo en simulación. La simulación conservó todos los campos de los pagos.

## Pruebas y evidencia

- `pnpm test`: 58 pruebas; suite existente más matriz de duración/frecuencia y regresiones IPC; escrituras en PostgreSQL real temporal.
- `pnpm test:ipc:live`: 1 prueba de descarga INDEC real → PostgreSQL → contrato antiguo → cuotas → API → simulación.
- `pnpm test:browser`: 1 prueba Chrome/Playwright → Configuración → simulación → aplicación → pendiente → cobro → edición contractual revisada → comprobación directa de PostgreSQL. Capturas de escritorio y móvil.
- `pnpm check`: sintaxis backend/gateway y build frontend verificados.

Los tests destructivos rechazan ejecutarse directamente sin el marcador y el nombre de base generados por el runner. El runner nunca utiliza `DATABASE_URL` del entorno para seleccionar su base: crea un clúster y una base únicos y los elimina al terminar. Los PDF de prueba se guardan fuera de `contratos/`.

Evidencia generada, fuera del control de versiones: `tmp/ipc-live-verification.json`, `tmp/ipc-browser-settings.png`, `tmp/ipc-browser-mobile.png`.

## Despliegue controlado

1. Guardar un backup verificable de PostgreSQL y de los PDF. Revisar este cambio y la migración 013. Probar primero en una copia de staging.
2. Instalar dependencias con el lockfile existente y construir con `pnpm build`.
3. Definir explícitamente `DATABASE_URL` para la base destino. Para separar esquema y arranque, usar `AUTO_MIGRATE=false` en el proceso del servidor.
4. Ejecutar `pnpm db:migrate` solo sobre el destino revisado y respaldado. El comando muestra host/base sin credenciales y registra las migraciones en `schema_migrations`. Si se usa el archivo de entorno local, Node 22 permite `node --env-file=.env backend/scripts/migrate.js`; verificar el destino del archivo antes de ejecutarlo.
5. Iniciar el backend con las variables del entorno de destino y `AUTO_MIGRATE=false`. La descarga de IPC es independiente de los pagos; un error externo no impide operar con datos almacenados.
6. En Configuración, comprobar fuente y último período. Consultar INDEC manualmente si corresponde.
7. Simular por contrato, revisar cláusulas, pagos, bonificaciones y diferencias. Exportar o conservar los resultados antes de aplicar. Resolver bloqueos; aplicar únicamente el alcance revisado.
8. Contrastar PostgreSQL, pendientes, dashboard, liquidaciones y WhatsApp. Revisar saldos parciales y créditos.

No se ejecutó ninguno de estos pasos sobre una base productiva durante la implementación.

## Riesgos y revisión pendiente

- Falta la simulación de los registros reales porque su base no estaba accesible.
- Los acuerdos manuales antiguos no estructurados y las cláusulas ambiguas requieren revisión documental.
- Las cuotas fuera de la vigencia modificada se bloquean para revisar el cronograma; no se borran ni se sustituyen automáticamente deudas con pagos.
- La política de redondeo acumulado documentada debe coincidir con cada contrato; cláusulas que exijan otra política requieren revisión.
- Cambios futuros del formato de INDEC provocan validación fallida y conservación de la última serie válida, con error visible para el operador.
- En bases grandes, conviene simular y aplicar por contrato para limitar duración de locks y facilitar la revisión.
