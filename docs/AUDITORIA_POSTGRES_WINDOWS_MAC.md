# Auditoría PostgreSQL Ferraro — Windows y macOS

Fecha: 5 de noviembre de 2026. HEAD auditado: `d3ef666`. Cambios locales, sin commit ni push. La instalación Mac se inspeccionó mediante transacciones de solo lectura y consultas de metadatos Docker. **No se tuvo acceso a Windows; no se afirma equivalencia de sus datos ni se elige una fuente de verdad.**

## 1. Diagnóstico Mac

**CORRECTO.** La aplicación está conectada a `127.0.0.1:54329/inmobiliaria`. La identidad SQL coincide con el servidor dentro de `ferraro-postgres`: clúster `7702592565026316322`, OID de base `16384`. Se observaron sesiones `ferraro:prod`, no un backend DEV sustituyendo la cartera.

Docker ejecuta **PostgreSQL 17.11**, imagen `postgres:17-alpine`, contenedor healthy, puerto publicado sólo en loopback y política `unless-stopped`. El volumen existente es `inmobiliariaferraro_ferraro_postgres_data`, montado para escritura en `/var/lib/postgresql/data`. No se creó ni cambió un volumen, contenedor o servidor real.

El inventario de aplicación contiene 45 tablas públicas, 459 columnas, 152 constraints, 96 índices, 146 triggers (dos de aplicación; el resto internos), 38 funciones y una secuencia. No hay índices inválidos o no preparados, constraints sin validar ni triggers de aplicación deshabilitados. Se comprobaron 36 relaciones FK sin encontrar huérfanos. La secuencia `integrity_findings_id_seq` no presenta riesgo de colisión. El reporte conserva definiciones SQL como hashes y metadatos estructurales, sin exportar literales de funciones/defaults ni datos personales.

Encoding UTF8, collation/ctype `en_US.utf8`, zona de sesión UTC. El diagnóstico normaliza la representación de fechas y el orden de los hashes; no cambia la configuración persistida.

**RIESGO CONFIRMADO de operación:** el volumen Compose tiene nombre derivado del proyecto. Se comprobó con `docker compose config`, sin levantar nada, que otro nombre de proyecto seleccionaría otro nombre de volumen. Eso puede aparentar una cartera vacía al trabajar desde otra carpeta/proyecto. No se corrigió renombrando volúmenes: se conserva el contenedor existente y se documenta su inicio por nombre. Windows debe identificar su propio volumen antes de ejecutar Compose desde otro checkout.

También se conserva la credencial local definida en Compose; no se imprime en el informe ni se rota durante esta auditoría. La exposición del servicio está limitada a loopback. Si se cambia esa credencial, debe hacerse coordinadamente con la conexión y el manifiesto, no editando sólo una variable de Docker sobre un volumen ya inicializado.

## 2. Diagnóstico Windows y cómo obtenerlo

**NO VERIFICADO:** versión efectiva, volumen, esquema, registros, PDFs, ACL, manifiesto y funcionamiento de Windows. No se deducen del historial ni del estado de Mac.

Se entrega `backend/scripts/audit-database.js`, disponible como `pnpm db:audit`. Usa Node.js y el cliente `pg` existente; no necesita instalar otra base ni binarios nativos PostgreSQL para diagnosticar. Puede observar una instalación antigua sin manifiesto utilizando su conexión local explícita. Si hay manifiesto, exige identidad y conexión coincidentes. No registra destinos, inicia la app, ejecuta seeds, importa PDFs, llama `nextval`, migra ni modifica PostgreSQL.

Con estos cambios de código disponibles en el repositorio de Windows, abrir PowerShell allí y ejecutar:

```powershell
$reporteFerraro = Join-Path $env:TEMP ("ferraro-windows-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
pnpm db:audit -- --output "$reporteFerraro"
Write-Output $reporteFerraro
```

Debe usar la conexión original de Windows en su `.env` local, mediante `PROD_DATABASE_URL` o el alias existente `DATABASE_URL`. **No copiar `.env`, manifiestos o `authority.key` desde Mac.** Si el contenedor existente está detenido, identificarlo antes de iniciarlo; el diagnóstico no lo crea ni lo inicia. Si no se dispone de Docker, `--no-docker` permite el diagnóstico SQL y deja expresamente la identificación del volumen sin verificar.

El archivo se escribe en UTF-8 sin depender de redirecciones de PowerShell y no sobrescribe otro archivo. Compartir únicamente ese JSON sanitizado. No compartir `.env`, carpetas privadas, dumps, claves ni PDFs. El reporte excluye nombres, DNI, domicilios, CBU, contraseñas, texto contractual, nombres de archivos PDF y rutas personales. Incluye cantidades, totales, estados, identidades técnicas y huellas necesarias para comparar. Sigue siendo un documento operativo que debe compartirse de forma privada, no publicarse en GitHub.

Estos archivos nuevos todavía no se publicaron en GitHub. El comando debe ejecutarse con esta corrección de código disponible en Windows; no basta con usar un checkout anterior que carezca de `db:audit`.

## 3. Comparación Windows/Mac

| Área | Mac verificado | Windows / clasificación actual |
| --- | --- | --- |
| PostgreSQL | 17.11, Docker 17-alpine | **NO VERIFICADO** |
| Migraciones | 001–018 aplicadas, ninguna pendiente | **NO VERIFICADO** |
| Objetos SQL | Inventariados, sin hallazgos descritos | **NO VERIFICADO** |
| Persistencia | Volumen e identidad coincidentes | **NO VERIFICADO** |
| Cartera | Un contrato, doce cuotas | **NO VERIFICADO** |
| Finanzas y relaciones | Saldos consistentes y FK sin huérfanos | **NO VERIFICADO** |
| PDFs | Un PDF accesible, vinculado y con hash coincidente | **NO VERIFICADO** |
| Código/dependencias | Node 22.23.4, pnpm 11.9.0, lockfile y código identificados por hash | **NO VERIFICADO** |
| Arranque | PROD registrada y activa; sin seeds/migraciones de inicio | **NO VERIFICADO** |

Cuando exista el JSON real de Windows, comparar sin conectarse a ninguna base:

```sh
pnpm db:audit -- --compare mac.json windows.json --output diferencias.json
```

La comparación distingue **Equivalentes**, **Compatibles sin cambios**, **Diferencia de configuración corregible**, **Migración realmente pendiente**, **Diferencia de datos que requiere conciliación**, **Riesgo confirmado** y **NO VERIFICADO**. Detalla objetos SQL diferentes, cantidades por tabla, totales, PDFs y procedencia de checksums. Las rutas locales de documentos se comparan también por separado: cambiar una ruta no demuestra por sí solo una divergencia económica.

Un mismo `system_identifier` identifica una misma procedencia física; una restauración lógica válida puede tener otro identificador y OID. No se exige que dos instalaciones usen el mismo puerto, ruta, OID o nombre de volumen para considerarlas compatibles. Eso tampoco demuestra igualdad de cartera: se comparan las filas, relaciones y archivos.

**Fuente de verdad: no definida.** Después de recibir los dos informes y revisar divergencias, corresponde consultarla con el usuario. No se fusiona, reemplaza o replica automáticamente ninguna instalación.

## 4. Migraciones

**CORRECTO en Mac.** Aplicadas 001–018; sin versiones desconocidas ni checksums alterados. Las 17 primeras tienen procedencia `adopted_unverified`: su hash actual fue adoptado, pero no prueba qué bytes se ejecutaron originalmente. La 018 está registrada como `executed_verified`. No se reescribieron SQL históricos ni hashes almacenados.

Se conserva el mecanismo existente: bloqueo de concurrencia, timestamps/duración/resultado, transacciones, preparación firmada con vencimiento, backup restaurado y comparación de datos antes de autorizar el commit. Los tests cubren fallos, repetición, concurrencia, estados obsoletos y caída del proceso durante DDL. No se necesita otra arquitectura de migraciones.

**CORREGIDO Y PROBADO:** los finales de línea no estaban fijados. Se reprodujo en un repositorio temporal que un checkout con `core.autocrlf=true` convertía SQL LF a CRLF y cambiaba su SHA-256. `.gitattributes` fija LF exclusivamente para `database/migrations/*.sql`; el mismo ensayo ahora conserva los bytes. No se modificó ninguno de los SQL 001–018.

Si Windows ya tiene archivos o hashes históricos basados en CRLF, **no convertir archivos ni reemplazar checksums ciegamente para desbloquearlo**. El diagnóstico informa hash estricto, formato de línea y hash normalizado auxiliar. Primero debe revisarse ese resultado. El hash normalizado es diagnóstico: no se usa para saltar la protección de migraciones.

**CORREGIDO Y PROBADO:** `db:prod:verify` podía decir “Actualización cancelada” al comparar una base que ya había retomado operaciones, aunque sólo estaba leyendo. Ahora explica que la comparación histórica difiere, que no aplicó ni revirtió una migración y que el diagnóstico corriente es `db:audit`. Sigue fallando si los datos no coinciden; no se relajó ninguna comprobación.

Procedimiento conservado:

```text
Código actualizado → db:audit / db:status → detectar pendientes
→ db:prod:prepare → respaldo restaurado y ensayo comparado
→ autorización humana → db:prod:migrate -- --confirm UUID
→ db:prod:verify antes de reanudar operaciones → pnpm app
```

No ejecutar migraciones por el mero cambio de sistema operativo ni repetir versiones aplicadas. Esta auditoría no preparó ni ejecutó otra migración real. La 018 de Mac ya había sido aplicada con autorización en el trabajo anterior. También se verificó por lectura el respaldo existente: archivo presente, SHA-256 coincidente, recibo HMAC válido, destino original coincidente y ensayo de restauración registrado. Su estado es aplicado; el plazo para una nueva aplicación ya venció. No se reutilizó la preparación ni se restauró sobre la base real.

## 5. Cartera y documentos de Mac

**CORRECTO.** Tres personas, una propiedad, un contrato en Revisión y doce cuotas Pendientes. Pagos registrados y componente manual: cero. Canon total de las doce cuotas registradas: ARS 5.302.479,60; servicios netos: ARS 120.000,00; IVA, punitorios y descuentos: cero. Saldo agregado de esas cuotas: ARS 5.422.479,60; créditos: cero. Incluye cuotas futuras: no es una afirmación de que todo ese saldo esté vencido hoy.

Un servicio confirmado por ARS 120.000,00, sin condonación; tres gastos no anulados por ARS 3.109,00. No hay discrepancias de moneda, proyección de servicios, estados/pagos o vínculos duplicados de gastos. No se recalculó ningún importe. La comparación final contra el snapshot del inicio de esta auditoría confirmó identidad, tablas de negocio y resumen financiero iguales. La aplicación continuó respondiendo 200 en Contratos, Cobros pendientes, Gastos y Dashboard.

El PDF está vinculado a contrato y propiedad, dentro de la carpeta administrada, presente y estable durante la lectura; su SHA-256 coincide con el registrado. Los documentos están en el filesystem del equipo, **fuera del volumen PostgreSQL**. Un dump de PostgreSQL contiene referencias, huellas y texto almacenado, pero no sustituye el respaldo de los PDFs originales.

**RIESGO CONFIRMADO para una transferencia:** la base guarda rutas absolutas locales. Una ruta Mac no se vuelve válida en Windows por restaurar el dump. No se modificaron rutas ni se reimportó ningún contrato; una eventual transferencia requiere conservar archivos y validar sus referencias por hash.

## 6. Arquitectura y automatismos

Se mantienen PROD Docker existente, DEV independiente opcional y TEST temporal. Los manifiestos aportan protección contra destinos cruzados; son locales a cada instalación y no deben sincronizarse entre máquinas. `pnpm app` necesita Node/pnpm y la base Docker ya disponible. DEV, pruebas y ensayo de restauración requieren los binarios PostgreSQL existentes indicados por `PG_BIN`; eso no registra un segundo servicio de producción.

**CORREGIDO Y PROBADO en la lógica de permisos:** la clave comprobaba bits POSIX incluso en Windows, donde no representan permisos por usuario/grupo. Se añadió `private-path.js`: Mac conserva propietario y permisos POSIX; Windows consulta ACL mediante PowerShell del sistema, exige propietario operador y acceso limitado a operador/SYSTEM/Administradores, y rechaza enlaces, ACL vacías/no canónicas o concesiones amplias. Se aplica a claves, manifiestos y directorios privados. No modifica ACL automáticamente ni permite omitir su verificación. La política fue probada con ACL controladas; **su ejecución nativa y las ACL de la instalación Windows siguen NO VERIFICADAS**.

El arranque no migra ni crea cartera. Sí conserva automatismos funcionales existentes: escaneo de PDFs al iniciar y cada 30 segundos según configuración, actualización IPC al iniciar y cada hora, sincronización BNA al iniciar y cada hora y worker del gateway cuando está configurado. Pueden escribir índices, estados técnicos y auditoría; la política de mora observada es manual. No se confundió “sin migraciones de inicio” con “aplicación de solo lectura”. El diagnóstico nuevo no inicia esos procesos. No se alteraron los automatismos ni los cálculos.

No se cambió Docker Compose, volumen, puerto, credencial, `.env`, UI, branding, lockfile, modelos contractuales o fórmulas financieras.

## 7. Cambios y pruebas

| Archivo | Cambio |
| --- | --- |
| `.gitattributes` | LF estable para SQL de migración, sin editar SQL. |
| `backend/src/database/private-path.js` | Validación POSIX/ACL por plataforma. |
| `backend/src/database/environment.js`, `production.js` | Uso del control de privacidad y mensaje preciso de verificación histórica. |
| `backend/src/database/audit.js` | Auditoría de solo lectura, inventario y comparación sanitizada. |
| `backend/scripts/audit-database.js` | CLI portable, exportación UTF-8, selección explícita del destino y errores sin datos privados. |
| `backend/src/database/snapshot.js` | Exporta el lector/hash existente para reutilizarlo; sin cambios a sus cálculos. |
| `package.json`, `tests/run-isolated.js` | Comando `db:audit` e incorporación de pruebas. |
| `tests/portable-audit.test.js`, `tests/database-operations.test.js` | Pruebas de auditoría, privacidad, portabilidad y mensaje posterior a operaciones legítimas. |
| `README.md`, esta guía | Operación diaria y límites verificados. |

**CORREGIDO Y PROBADO:** `pnpm test`, 234 casos: **233 aprobados, cero fallos y uno omitido** por falta de OCR nativo local. `pnpm check` y `git diff --check` aprobados. Las diez pruebas nuevas cubren conservación exacta antes/después de auditar, 017 sin aplicar 018, huérfanos y secuencias sin reparar, PDFs alterados/rutas ajenas, comparación de datos y rutas, CLI sin manifiesto/binarios nativos, sanitización de Docker, ACL, checkout CRLF y reinicio PostgreSQL aislado con identidad/datos/versiones conservados. Los ensayos de restauración y fallos de migración anteriores siguen pasando.

**CORRECTO, alcance publicado:** se inspeccionó el [run 42080687827](https://github.com/sebazarazua/inmobiliaria_ferraro/actions/runs/42080687827) del HEAD `d3ef666`: privacidad, check y **224/224 pruebas**, incluido OCR nativo, aprobados en Ubuntu. El navegador estaba omitido por tratarse de un push. El workflow no fue modificado. Los cambios locales actuales **no están verificados todavía en CI remoto** porque no se hizo commit ni push.

**NO VERIFICADO:** ejecución nativa Windows y reinicio real del contenedor de producción. No se detuvo Docker ni la aplicación real para forzar fallos. El reinicio probado usa PostgreSQL temporal aislado, no una supuesta copia de Windows. La configuración del volumen y la política de reinicio Docker sí se inspeccionaron. No se repitieron pruebas de navegador completas porque no hubo cambios de interfaz; la aplicación Mac continuó respondiendo en PROD.

## 8. Operación diaria

En Windows y Mac, una vez registrada y verificada la instalación:

```sh
pnpm install --frozen-lockfile
pnpm app
```

Abrir http://127.0.0.1:4173. Si Docker está detenido, iniciar Docker Desktop y, después de verificar el nombre del contenedor existente, `docker start ferraro-postgres`. No usar `compose down -v`, recrear volúmenes ni levantar Compose con otro proyecto para resolver una conexión fallida. Las variables `POSTGRES_*` del contenedor no reemplazan ni reinicializan por sí solas un volumen existente.

`pnpm dev` sigue siendo desarrollo aislado, sin cartera inventada; `pnpm test` es temporal. No usar `db:up` para abrir la cartera real: ese alias prepara DEV. No modificar `DATABASE_URL` para alternar entre estos comandos.

Si Windows carece de manifiesto, primero obtener su auditoría. No copiar la identidad de Mac ni eliminar la comprobación para abrirlo. El procedimiento existente de preparación puede registrar el destino local después de revisar esa instalación, conservando los requisitos de respaldo/ensayo. Si faltan binarios para ese procedimiento, se evalúa su disponibilidad con el informe; no se instala automáticamente un servicio PostgreSQL adicional.

## 9. Replicación

**NO VERIFICADO que haga falta transferir datos.** Igualar código, dependencias o configuración no exige copiar la cartera. Una migración pendiente tampoco implica que otra máquina sea la fuente principal. No se implementó sincronización bidireccional.

Si ambos informes muestran cambios reales distintos, el conflicto debe conciliarse con el usuario. Antes de cualquier transferencia: elegir origen/destino con evidencia, respaldar **ambas** bases y ambas carpetas de documentos, restaurar y ensayar en aislamiento, comparar filas/relaciones/secuencias/estados/saldos y hashes de PDFs, identificar exactamente lo que se reemplazaría y pedir aprobación explícita. **REQUIERE AUTORIZACIÓN** cualquier escritura de transferencia, cambio de rutas reales, restauración, modificación de volumen o ajuste de hashes históricos.

Para una transferencia aprobada se usaría `pg_dump`/`pg_restore` y una copia verificada de documentos. Nunca copiar `PGDATA`, directorios físicos o volúmenes entre sistemas operativos como sustituto de una restauración validada.

## 10. Pendientes reales

| Prioridad | Estado | Acción |
| --- | --- | --- |
| P1 | **NO VERIFICADO** | Obtener el JSON de Windows con su conexión, esquema, cartera, archivos y volumen reales. |
| P1 | **NO VERIFICADO** | Probar allí ACL, arranque y herramientas disponibles. No declarar compatibilidad nativa completa con pruebas simuladas. |
| P1 si aparece | **REQUIERE AUTORIZACIÓN** | Resolver discrepancias de datos, archivos/checksums históricos o migraciones efectivamente pendientes, tras preparar respaldo y ensayo. |
| P2 | **RIESGO CONFIRMADO** | Conservar el proyecto/volumen existente; revisar cualquier cambio de carpeta/proyecto antes de usar Compose. |
| P2 | **NO VERIFICADO** | Verificar los cambios locales en CI después de publicación autorizada; el HEAD publicado ya está aprobado. |
| P2 si se requiere | **REQUIERE AUTORIZACIÓN** | Elegir fuente de verdad y ensayar una transferencia sólo después de comparar ambas instalaciones. |

Informe Mac sanitizado local: `tmp/portable-verification/mac-verificado.json`. Logs locales: `tests.log` y `check.log` en esa carpeta, ignorada por Git. El JSON contiene hashes de tablas/código/lockfile, referencias técnicas de Docker y el detalle de los controles; no contiene credenciales ni datos identificatorios. No se generó un informe ficticio de Windows.

Referencias primarias consultadas: [Node.js: limitaciones de chmod en Windows](https://nodejs.org/api/fs.html#fschmodpath-mode-callback), [Docker: nombre del proyecto](https://docs.docker.com/compose/how-tos/project-name/) y [Docker: volúmenes Compose](https://docs.docker.com/reference/compose-file/volumes). Los permisos Windows requieren ACL; el nombre del proyecto interviene en los nombres de recursos Compose.
