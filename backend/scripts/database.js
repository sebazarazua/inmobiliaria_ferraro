const fs=require('node:fs'),path=require('node:path');
const {Pool}=require('pg');
const E=require('../src/database/environment'),M=require('../src/database/migrations');
async function main(){
  const envFile=path.resolve(__dirname,'../../.env');if(fs.existsSync(envFile))process.loadEnvFile(envFile);
  const command=process.argv[2],args=process.argv.slice(3).filter(a=>a!=='--'),option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  if(command==='dev-setup'){await require('../src/database/development').migrateDev();console.log('DEV independiente preparado sin crear personas, propiedades, contratos ni cuotas. Para Ferraro real usá pnpm app.');return;}
  if(command==='dev-migrate'){console.log(JSON.stringify(await require('../src/database/development').migrateDev(),null,2));return;}
  if(command==='dev-reset'){await require('../src/database/development').resetDev();console.log('DEV reiniciado; clúster anterior conservado fuera del repositorio.');return;}
  if(command==='dev-stop'){const ctx=E.context({environment:'dev'}),db=new Pool({connectionString:ctx.url});try{await E.validate(db,ctx);const n=(await db.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n;if(n)throw new Error('Detené pnpm dev antes de detener su PostgreSQL.');}finally{await db.end();}require('../src/database/cluster').stopCluster({data:path.join(ctx.cluster_directory,'pgdata')});console.log('PostgreSQL DEV detenido. PROD no se modificó.');return;}
  const P=require('../src/database/production');
  if(command==='prod-prepare'){console.log(JSON.stringify(await P.prepare(process.env.PROD_DATABASE_URL||process.env.DATABASE_URL),null,2));return;}
  if(command==='prod-migrate'){console.log(JSON.stringify(await P.apply({file:option('prepare'),confirmation:option('confirm')}),null,2));return;}
  if(command==='prod-verify'){console.log(JSON.stringify(await P.verifyProduction({file:option('prepare')}),null,2));return;}
  if(['status','diagnose'].includes(command)){
    const environment=option('env')||process.env.FERRARO_ENV||'dev';if(!['dev','test','prod'].includes(environment))throw new Error('Entorno inválido.');let ctx;
    if(environment==='prod'&&!fs.existsSync(E.manifestPath('prod')))ctx=await P.observeProduction(process.env.PROD_DATABASE_URL||process.env.DATABASE_URL);else ctx=E.context({environment});
    const db=new Pool({connectionString:ctx.url,max:1,application_name:'ferraro:readonly'});try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await E.validate(db,ctx);console.log(JSON.stringify({environment,target:E.sanitized(ctx.url),identity:ctx.identity,migrations:await M.status(db)},null,2));await db.query('ROLLBACK');}finally{await db.end();}
    if(command==='diagnose')console.log(JSON.stringify(await require('./diagnose-database').diagnose(ctx.url),null,2));return;
  }
  throw new Error('Comando de base inexistente. Usá los scripts db:dev:*, db:status, db:diagnose o db:prod:*.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
