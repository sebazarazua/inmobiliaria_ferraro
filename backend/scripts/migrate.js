const {openDatabase}=require('../src/database');
async function main(){
  if(!process.env.DATABASE_URL)throw new Error('Definí DATABASE_URL explícitamente para la base que vas a migrar.');
  const target=new URL(process.env.DATABASE_URL);
  console.log(`Migraciones pendientes: ${target.hostname}:${target.port||5432}${target.pathname}`);
  const db=await openDatabase(process.env.DATABASE_URL,{runMigrations:true});
  try{console.log((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version).join('\n'));}finally{await db.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
