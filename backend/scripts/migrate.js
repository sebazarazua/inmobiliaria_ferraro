// No legacy entry point may migrate an arbitrary DATABASE_URL.
console.error('Migración directa bloqueada. DEV: pnpm db:dev:migrate. PROD: db:prod:prepare y db:prod:migrate -- --confirm ID.');
process.exitCode=1;
