// Portable Node entry point: no shell redirects, PG installation, migrations or app startup required.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const E=require('../src/database/environment'),M=require('../src/database/migrations'),C=require('../src/database/cluster');
const {auditDatabase,dockerInspection,compareAudits,hash}=require('../src/database/audit');
function parse(args){const out={docker:true};for(let i=0;i<args.length;i++){const a=args[i];if(a==='--')continue;if(a==='--no-docker'){out.docker=false;continue;}if(a==='--output'&&args[i+1]){out.output=args[++i];continue;}if(a==='--compare'&&args[i+2]){out.compare=[args[++i],args[++i]];continue;}throw new Error('Uso: pnpm db:audit -- --output archivo.json [--no-docker], o --compare mac.json windows.json --output diferencias.json');}return out;}
function sourceHash(){
  const entries=[];
  function walk(dir){if(!fs.existsSync(dir))return;for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(item.isFile()&&/\.(?:js|jsx|ts|tsx|json|css)$/.test(item.name))entries.push([path.relative(E.ROOT,file).split(path.sep).join('/'),hash(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'))]);}}
  for(const dir of ['backend/src','backend/scripts','frontend/src','gateway/src'])walk(path.join(E.ROOT,dir));
  for(const file of ['package.json','docker-compose.yml','frontend/vite.config.js','.gitattributes'])if(fs.existsSync(path.join(E.ROOT,file)))entries.push([file,hash(fs.readFileSync(path.join(E.ROOT,file),'utf8').replace(/\r\n/g,'\n'))]);
  entries.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return hash(entries);
}
function runtime(){
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:E.ROOT,encoding:'utf8',timeout:5000,windowsHide:true});
  const tools={};for(const name of ['pg_dump','pg_restore','initdb','pg_ctl']){const r=C.run(name,['--version'],{allowFailure:true});tools[name]=r.status===0?r.stdout.trim().match(/\d+(?:\.\d+)+/)?.[0]||'available':null;}
  const lock=path.join(E.ROOT,'pnpm-lock.yaml'),manifest=JSON.parse(fs.readFileSync(path.join(E.ROOT,'package.json'),'utf8'));
  return{platform:process.platform,architecture:process.arch,node:process.version,required_node:manifest.engines.node,pnpm:process.env.npm_config_user_agent?.match(/pnpm\/([\d.]+)/)?.[1]||null,
    commit:git.status===0&&/^[a-f0-9]{40}$/.test(git.stdout.trim())?git.stdout.trim():null,lockfile_sha256:fs.existsSync(lock)?hash(fs.readFileSync(lock,'utf8').replace(/\r\n/g,'\n')):null,source_sha256:sourceHash(),
    migration_files_sha256:hash(M.files().map(({sql,...r})=>r)),native_postgres_tools:tools,
    auto_migrate_requested:process.env.AUTO_MIGRATE==='true',host_loopback:require('../src/lib/access').isLoopback(process.env.HOST||'127.0.0.1'),port:Number(process.env.PORT||4173),
    gateway_configured:!!(process.env.WHATSAPP_GATEWAY_URL&&process.env.FERRARO_GATEWAY_SECRET),ocr_requested:process.env.LATE_FEE_OCR==='true'};
}
async function main(){
  const options=parse(process.argv.slice(2));let report;
  if(options.compare)report=compareAudits(...options.compare.map(file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))));
  else{
    const file=path.join(E.ROOT,'.env');if(fs.existsSync(file))process.loadEnvFile(file);
    const registered=fs.existsSync(E.manifestPath('prod'))?E.context({environment:'prod'}):null,configured=process.env.PROD_DATABASE_URL||process.env.DATABASE_URL;
    if(registered&&configured&&configured!==registered.url)throw new Error('La URL configurada difiere de PROD registrada. Auditoría cancelada sin cambiar de destino.');
    const url=registered?.url||configured;if(!url)throw new Error('Falta una conexión explícita a la instalación a auditar. Configurá PROD_DATABASE_URL o DATABASE_URL localmente; no compartas su valor.');
    report=await auditDatabase(url,{manifest:registered});report.runtime=runtime();
    report.docker=options.docker?dockerInspection(url,report.target.identity):{verified:false,reason:'not_requested'};
  }
  const json=JSON.stringify(report,null,2)+'\n';
  if(options.output){fs.writeFileSync(path.resolve(options.output),json,{encoding:'utf8',flag:'wx',mode:0o600});console.log('Informe sanitizado UTF-8 generado. No se modificó PostgreSQL.');}else process.stdout.write(json);
}
if(require.main===module)main().catch(e=>{const safe=/^(Uso:|La URL configurada difiere|Falta una conexión explícita|Informe de auditoría inválido|La ruta|No se pudo verificar la ACL|Windows no devolvió)/.test(e.message);const code=/^[A-Z0-9_]{2,40}$/.test(e.code||'')?e.code:'ERROR';console.error(safe?e.message:`Auditoría no completada (${code}). No se muestran credenciales ni mensajes SQL con datos.`);process.exitCode=1;});
module.exports={parse,runtime};
