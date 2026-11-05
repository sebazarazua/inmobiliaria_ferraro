# PostgreSQL: entornos, respaldos y migraciones

Fecha: 5 de noviembre de 2026. Base: `15c5ca1`, HEAD y origin/main sincronizados al comenzar. Implementación local sin commit ni push. No se aplicó 018 ni se modificaron datos de producción.

## Arquitectura

| Entorno | Selección | Identificación y escritura |
| --- | --- | --- |
| DEV | `pnpm dev` | Clúster físico independiente, manifiesto privado, system_identifier, OID de base, UUID y secreto contrastado con marcador SQL. Sólo después se permiten migraciones y seeds sintéticos. |
| TEST | `pnpm test` | Clúster nuevo por ejecución, manifiesto propio y marcador SQL. No consume `.env`. Se detiene y elimina al terminar; no se acepta sólo un nombre, puerto o flag TEST. |
| PROD | `pnpm start` | Destino registrado por preparación, identidad física/OID validados y URL fijada. Sin seeds ni migraciones al iniciar; `AUTO_MIGRATE=true` produce error. |

Los manifiestos se guardan en `~/.local/share/ferraro/`, con carpetas 0700 y archivos 0600. Contienen secretos de conexión: no copiarlos al repositorio. `FERRARO_STATE_DIR` permite otra carpeta privada del operador. Si falta identificación o cambia el servidor, se bloquea la operación. No hay fallback a una base real.

DEV usa su carpeta sintética de PDFs; la configuración impide dirigir el importador a la carpeta de contratos reales. El arranque DEV descarta variables de conexión PROD y credenciales del gateway. Su reset verifica identidad, finalidad y ausencia de otras sesiones y conserva el clúster anterior mediante renombrado; nunca borra/recrea PROD. Los clones de respaldos reales están separados del TEST sintético y no pueden abrirse como aplicación de prueba.

Estas guardas protegen contra errores operativos. El propietario del sistema y un superusuario SQL pueden modificar deliberadamente los controles; los manifiestos no sustituyen permisos de infraestructura ni autenticación de la aplicación.

## Uso diario en macOS

```sh
export PG_BIN=/opt/homebrew/opt/postgresql@17/bin
pnpm db:dev:setup
pnpm dev
```

No editar `DATABASE_URL` para alternar DEV y TEST. `db:dev:setup` crea y migra DEV y agrega una cartera ficticia; repetirlo conserva esa cartera. `db:dev:migrate` actualiza sólo DEV. `db:dev:reset` requiere detener DEV y conserva su versión anterior. `db:up`/`db:down` son alias para preparar/detener DEV; ya no detienen el contenedor real. El Docker existente mantiene imagen, puerto y volumen.

`pnpm db:status` y `pnpm db:diagnose` seleccionan DEV por defecto. Para observar producción: `pnpm db:status -- --env prod` y `pnpm db:diagnose -- --env prod`. Informan destino sin contraseña y no escriben. Un manifiesto PROD existente fija el destino; no se cambia al modificar una variable.

## Migraciones

Se preservaron íntegros `schema_migrations` y SQL 001–018. Se añade metadata administrativa en `ferraro_system`, no una migración histórica reescrita. Cada ejecución nueva conserva versión, SHA-256, timestamps, duración, resultado y código de error; la preparación identifica además la operación PROD.

Los hashes de versiones antiguas se adoptan como `adopted_unverified`: observar el archivo actual no demuestra qué SQL se ejecutó originalmente. Sólo una ejecución controlada nueva recibe `executed_verified`. Un hash cambiado o versión desconocida bloquean migración/arranque. El arranque compatible de PROD no escribe metadata para adoptarlos.

Un advisory lock serializa migraciones. DEV/TEST usan una transacción por archivo; PROD aplica todo el lote en una transacción externa y revierte ante cualquier fallo o diferencia financiera. La app mantiene un bloqueo compartido durante su vida; el mantenimiento requiere exclusividad y ausencia de otras sesiones. Se bloquean también las tablas públicas. Los intentos fallidos de PROD se guardan en su carpeta privada porque el rollback debe incluir la metadata SQL del lote.

## Actualización de producción

Detener aplicación/watchers e integraciones escritoras. La conexión existente `.env` se conserva; puede usarse `PROD_DATABASE_URL` explícito. No mostrar su contenido.

1. `pnpm db:prod:prepare`: identifica servidor/base, exige ausencia de sesiones, toma snapshot y bloqueos SHARE, ejecuta `pg_dump -Fc` consistente fuera del repositorio, calcula SHA-256 y restaura realmente en otro clúster. Aplica las migraciones a esa copia y compara todas las filas/columnas anteriores de tablas públicas, pagos, servicios, gastos, condonaciones, estados, créditos y saldos calculados por el código existente.
2. La preparación genera UUID y plan firmado HMAC, válido una hora, ligado a identidad, estado de datos/esquema/secuencias, archivos SQL, hash del respaldo y resultado de restauración. No migra la fuente.
3. Revisar resultados, respaldo y cambios SQL. Sólo con autorización humana ejecutar `pnpm db:prod:migrate -- --confirm UUID`. El UUID exacto es obligatorio. Se revalidan firma, vencimiento, archivos, respaldo, destino y estado, y se exige otra vez que no haya sesiones escritoras.
4. El lote real es transaccional; se comparan datos y finanzas antes de confirmar. Un reintento tras commit reconoce la operación y no la duplica. `pnpm db:prod:verify` comprueba esquema y preservación contra la preparación. Ejecutarlo antes de reanudar escrituras de negocio: pagos posteriores legítimos cambian la comparación.
5. Iniciar frontend/backend de la misma versión mediante `pnpm start`, con `AUTO_MIGRATE=false`.

El script antiguo `backend/scripts/migrate.js` rechaza conexiones arbitrarias e indica estos comandos. No ejecutar SQL manual para evitar sus guardas.

Los comandos nativos tienen límite de 120 segundos: para bases grandes hay que revisar el tiempo y espacio del respaldo antes de operar. Se necesita acceso a `pg_control_system()` y permisos para dump, tablas y DDL; ante permisos insuficientes se bloquea sin degradar la identidad a nombres/puertos.

## Recuperación y retención

Un fallo cancela el lote: no hay down migration, borrado ni restauración automática. Si cae el proceso durante la transacción, PostgreSQL revierte; volver a preparar si venció el plan o cambió el estado. Una caída después del commit permite repetir el UUID sin duplicación. Si falló la restauración de prueba no se emite preparación válida. Los respaldos y diagnósticos privados fallidos se conservan para revisión.

Política local: conservar el respaldo previo completo y su plan durante al menos 30 días y hasta que exista una actualización posterior verificada y un respaldo independiente comprobado. No hay purga automática. Revisar espacio periódicamente y eliminar manualmente sólo paquetes completos ya reemplazados, con la app detenida y sin afectar archivos vigentes. Los DEV retirados son sintéticos; pueden retirarse manualmente después de comprobar el DEV actual. No sincronizar respaldos reales a Git, artefactos de CI o carpetas públicas.

Una restauración real requiere aprobación separada, detener escritores y cotejar operaciones posteriores para no perder pagos. Esta entrega sólo restaura copias temporales de ensayo.

## CI y evidencia

Se consultaron los logs reales del [run 41941019263](https://github.com/sebazarazua/inmobiliaria_ferraro/actions/runs/41941019263): Ubuntu 24.04, PostgreSQL 16, check aprobado, `initdb` aprobado y `pg_ctl` fallido antes de los tests. El runner anterior eliminaba `postgres.log`, por lo que no se puede afirmar la causa original exacta. No hay evidencia de fallo del motor financiero.

Se reprodujo en Linux con un usuario sin permisos sobre `/var/run/postgresql`: falla al crear el lock del socket; con `-k` apuntando a carpeta temporal privada inicia correctamente. El runner usa ahora socket privado, puerto libre, rutas cortas en macOS, diagnóstico antes de limpiar y borrado limitado a carpetas temporales propias. Windows no fue ejecutado.

Se mantienen todas las suites financieras, privacidad y OCR. CI exige Poppler, Tesseract y español mediante preflight: ya no puede informar éxito si la integración OCR nativa se omite por falta de herramientas. El job opcional de navegador ejecuta Chrome y WebKit con binarios de la misma dependencia Playwright CLI. Los fallos de PostgreSQL conservan su diagnóstico como artefacto corto, sin respaldos ni datos reales.

Las correcciones todavía no están publicadas: no hay un run remoto con este parche. Verificar GitHub después de la publicación autorizada es PENDIENTE. Referencias técnicas: [pg_ctl](https://www.postgresql.org/docs/17/app-pg-ctl.html), [bloqueos](https://www.postgresql.org/docs/17/explicit-locking.html), [funciones administrativas](https://www.postgresql.org/docs/17/functions-admin.html).

## Resultados de esta ejecución

| Resultado | Clasificación | Evidencia |
| --- | --- | --- |
| DEV independiente, creación, migración, reset recuperable, esquema viejo y rechazo de conexiones cruzadas | **RESUELTO Y PROBADO** | Pruebas DB09–DB13/DB18 y arranque real de DEV. API devuelve contrato sintético y Cobros pendientes carga en navegador. |
| TEST nuevo, socket privado, diagnóstico y limpieza restringida | **RESUELTO Y PROBADO** | Suites completas y DB14; reproducción Linux de permisos del socket y arranque con carpeta propia. |
| PROD sin seeds/migraciones al iniciar, rechazo de AUTO_MIGRATE, exclusión de escritores | **RESUELTO Y PROBADO** | DB01/DB07/DB08 sobre fixtures sintéticas independientes. |
| Backups, restauración real, ensayo, firma, vencimiento, stale state y reintentos | **RESUELTO Y PROBADO** | DB02–DB06/DB16/DB19. Preparación real completada sin migrar la fuente. |
| Transacción interrumpida y reintento | **RESUELTO Y PROBADO** | DB17 mata el proceso durante DDL; confirma rollback y aplicación completa posterior. Sólo datos ficticios. |
| 017→018, índice/triggers/findings y conservación financiera | **RESUELTO Y PROBADO** | E02–E04, DB02/DB15 y ensayo de respaldo real aislado. Historial duplicado se conserva y se informa. |
| Aplicación real de 018 | **BLOQUEADO** | Confirmada pendiente por lectura después del ensayo. Requiere autorización explícita, preparación nueva vigente y ausencia de escritores. No se ejecutó. |
| Corrección de Actions | **IMPLEMENTADO SIN VERIFICAR** en GitHub | Workflow y runner corregidos; run original inspeccionado. No hay ejecución remota del parche sin publicar estos cambios. |
| Publicar cambios y ejecutar CI remoto completo | **PENDIENTE** | No se hizo commit, push ni despliegue. Tras publicación autorizada ejecutar workflow con navegador habilitado. |
| OCR nativo local / remoto con este parche | **IMPLEMENTADO SIN VERIFICAR** | En esta Mac faltan Poppler/Tesseract: E10 se omite expresamente. CI mantiene instalación de herramientas y exige preflight exitoso; todavía no se ejecutó el parche allí. |

Validación local final:

- `pnpm test`: **219 casos, 218 aprobados, 0 fallos, 1 omitido** (E10 OCR nativo).
- `pnpm check`: sintaxis, privacidad, gateway y build aprobados.
- `UX_BROWSERS=chrome,webkit pnpm test:browser`: **14 aprobados, 0 fallos**.
- `git diff --check`: sin errores. `.env`, lockfile y SQL 001–018 sin modificaciones.
- Se añadieron 20 pruebas de operación de bases, incluidas credenciales inválidas, checksums, concurrencia, backups y comparación independiente de zona horaria/locale.

La preparación real confirmó respaldo restaurable y preservación de todas las tablas públicas anteriores, sus relaciones y resumen financiero al ensayar 018. Hubo un primer rechazo conservador por representación de timestamps entre Docker UTC y macOS; no produjo preparación ni cambios en la fuente. Se corrigió la serialización canónica UTC y orden independiente de locale, se añadió DB20 y la preparación posterior pasó. La fuente conserva 001–017; 018 sigue pendiente. Los respaldos reales permanecen exclusivamente en la carpeta privada externa indicada por el comando, sin copiarse a este informe o a Git.

Archivos: nuevos módulos `backend/src/database/{environment,cluster,development,migrations,snapshot,production}.js`, comandos `backend/scripts/{database,launch,check-native-ocr}.js` y `tests/database-operations.test.js`; adaptación del acceso a DB, configuración, runner, guardas de carpeta DEV, scripts pnpm, CI, `.env.example`, README y comentario de Docker. No se cambió lógica financiera, UI, branding, migraciones históricas, versión PostgreSQL o dependencias.

Los logs sintéticos se conservan localmente en `tmp/database-verification/`, ignorados por Git. La preparación real y sus credenciales permanecen fuera del repositorio. DEV quedó disponible en la URL de Vite informada al arrancar (en esta ejecución, http://localhost:5174 porque 5173 ya tenía otro Vite del mismo proyecto). La API está en http://127.0.0.1:4173 y apunta exclusivamente a `ferraro_dev`.
