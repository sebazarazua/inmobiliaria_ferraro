require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg'),{spawn}=require('node:child_process');
const E=require('../backend/src/database/environment'),M=require('../backend/src/database/migrations'),C=require('../backend/src/database/cluster');
const A=require('../backend/src/database/audit'),{snapshot}=require('../backend/src/database/snapshot');
async function fixture(t,{version='019'}={}){
  const root=C.temporaryRoot('ferraro-dbtest-'),admin=new Pool({connectionString:process.env.DATABASE_URL}),name='audit_'+crypto.randomBytes(8).toString('hex'),u=new URL(process.env.DATABASE_URL);u.pathname='/'+name;await admin.query('CREATE DATABASE '+name);const db=new Pool({connectionString:u.href,max:1});
  t.after(async()=>{await db.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();C.removeTemporary(root);});
  for(const f of M.files().filter(f=>f.version.slice(0,3)<=version)){await db.query(f.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[f.version]);}
  const [person,property,contract,installment,document]=Array.from({length:5},()=>crypto.randomUUID());
  await db.query("INSERT INTO persons(id,full_name,document_number) VALUES($1,'CANARY_PERSON','CANARY_DNI')",[person]);
  await db.query("INSERT INTO properties(id,code,address,normalized_address) VALUES($1,'CANARY_CODE','CANARY_ADDRESS','canary address')",[property]);
  await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,cbu) VALUES($1,'CANARY_CONTRACT',$2,$3,'Residencial',12,'2025-01-01','2025-12-31',100000,'ARS','1234567890123456789012')",[contract,property,person]);
  await db.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES($1,$2,'2025-01','2025-01-10',100000,'ARS')",[installment,contract]);
  const file=path.join(root,'CANARY_FILENAME.pdf'),bytes=Buffer.from('%PDF-1.4 CANARY_CONTRACT_CONTENT');fs.writeFileSync(file,bytes);const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  await db.query("INSERT INTO documents(id,filename,absolute_path,sha256,contract_id,property_id,extracted_text) VALUES($1,'CANARY_FILENAME.pdf',$2,$3,$4,$5,'CANARY_CONTRACT_CONTENT')",[document,file,sha,contract,property]);
  await db.query("INSERT INTO settings(key,value) VALUES('import_directory',$1),('late_fee_policy',$2)",[root,JSON.stringify({mode:'manual',reason:'CANARY_REASON'})]);
  return{root,url:u.href,db,file,sha,person,property,contract,installment};
}
test('A01. auditoría 019 es de solo lectura, completa y no exporta datos personales',async t=>{
  const s=await fixture(t),before=await snapshot(s.db),report=await A.auditDatabase(s.url),after=await snapshot(s.db);assert.deepEqual(after,before);assert.equal(report.server.read_only,'on');assert.equal(report.rows.contracts.count,1);assert.equal(report.rows.installments.count,1);assert.equal(report.finance.totals.ARS.due,'100000.00');assert.equal(report.documents.items[0].hash_matches,true);assert.equal(report.relationships.findings.length,0);assert.ok(report.schema.constraints.count>0);assert.ok(report.schema.indexes.objects.some(i=>i.name==='installment_services_expense_uq'&&i.is_unique));assert.equal(report.migrations.pending.length,0);
  const text=JSON.stringify(report);for(const canary of ['CANARY_','1234567890123456789012',s.root,s.file])assert.equal(text.includes(canary),false,canary);
});
test('A02. esquema 017 se diagnostica sin aplicar 018 ni crear metadata',async t=>{
  const s=await fixture(t,{version:'017'}),before=await snapshot(s.db),report=await A.auditDatabase(s.url);assert.deepEqual(report.migrations.pending.map(m=>m.version),['018_financial_integrity.sql','019_payment_receipts.sql']);assert.equal(report.migrations.historical_unverified.length,17);assert.deepEqual(await snapshot(s.db),before);assert.equal((await s.db.query("SELECT to_regclass('ferraro_system.migration_runs') value")).rows[0].value,null);
});
test('A03. detecta huérfanos y secuencia atrasada sin repararlos',async t=>{
  const s=await fixture(t);await s.db.query("SET session_replication_role='replica'");await s.db.query('UPDATE contracts SET tenant_id=$1',[crypto.randomUUID()]);await s.db.query("SET session_replication_role='origin'");await s.db.query("INSERT INTO integrity_findings(id,check_name,details_json) VALUES(500,'synthetic','{}')");const before=await snapshot(s.db),report=await A.auditDatabase(s.url);assert.ok(report.relationships.findings.some(f=>f.table==='contracts'&&f.orphan_rows===1));assert.ok(report.sequences.some(q=>q.table_name==='integrity_findings'&&q.collision_risk));assert.deepEqual(await snapshot(s.db),before);
});
test('A04. PDFs alterados o rutas de otra plataforma se informan sin mover ni reimportar',async t=>{
  const s=await fixture(t);fs.appendFileSync(s.file,'changed');assert.equal((await A.auditDatabase(s.url)).documents.items[0].hash_matches,false);const foreign=process.platform==='win32'?'/Users/example/contract.pdf':'C:\\Users\\example\\contract.pdf';await s.db.query('UPDATE documents SET absolute_path=$1',[foreign]);const r=await A.auditDatabase(s.url);assert.equal(r.documents.items[0].path.kind,'foreign_absolute');assert.equal(r.documents.items[0].path.exists,false);assert.equal(r.rows.documents.count,1);assert.equal(JSON.stringify(r).includes(foreign),false);
});
test('A05. comparación distingue importes, migraciones, rutas y no elige fuente ni fusiona',async t=>{
  const s=await fixture(t),first=await A.auditDatabase(s.url),same=A.compareAudits(first,first);assert.equal(same.automatic_transfer,false);assert.match(same.source_of_truth,/NO DEFINIDA/);assert.equal(same.differences.find(d=>d.area==='Registros y relaciones').classification,'Equivalentes');
  const copied=path.join(s.root,'relocated.pdf');fs.copyFileSync(s.file,copied);await s.db.query('UPDATE documents SET absolute_path=$1',[copied]);const relocated=A.compareAudits(first,await A.auditDatabase(s.url));assert.ok(relocated.differences.some(d=>d.area==='Rutas locales'));assert.equal(relocated.differences.find(d=>d.area==='Registros y relaciones').classification,'Equivalentes');
  await s.db.query('UPDATE installments SET expected_amount=expected_amount+1');const changed=A.compareAudits(first,await A.auditDatabase(s.url));assert.equal(changed.differences.find(d=>d.area==='Importes y saldos').classification,'Diferencia de datos que requiere conciliación');
  const stale=structuredClone(first);stale.migrations.pending=[{version:'018_financial_integrity.sql'}];assert.ok(A.compareAudits(first,stale).differences.some(d=>d.classification==='Migración realmente pendiente'));assert.throws(()=>A.compareAudits(first,{}),/incompleto/);const noVolume=structuredClone(first);noVolume.docker={verified:true,postgres_identity_verified:true,identity_probe_succeeded:true,mounts:[]};assert.equal(A.compareAudits(noVolume,noVolume).differences.find(d=>d.area==='Persistencia Docker').classification,'Riesgo confirmado');
});
test('A06. CLI portable exporta UTF-8 sin manifiesto ni binarios nativos, no sobrescribe',async t=>{
  const s=await fixture(t),out=path.join(s.root,'windows-audit.json'),env={...process.env,FERRARO_STATE_DIR:path.join(s.root,'unregistered'),DATABASE_URL:s.url,PROD_DATABASE_URL:s.url,PG_BIN:path.join(s.root,'not-installed')};
  async function run(){let output='';const child=spawn(process.execPath,['backend/scripts/audit-database.js','--no-docker','--output',out],{cwd:E.ROOT,env});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;});const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});return{code,output};}
  const before=await snapshot(s.db),result=await run();assert.equal(result.code,0,result.output);const report=JSON.parse(fs.readFileSync(out,'utf8'));assert.equal(report.target.manifest_verified,false);assert.equal(report.runtime.native_postgres_tools.pg_dump,null);assert.equal(report.docker.verified,false);assert.equal(fs.existsSync(path.join(env.FERRARO_STATE_DIR,'prod.json')),false);assert.equal((await run()).code,1);assert.deepEqual(await snapshot(s.db),before);
});
test('A07. inspección Docker sólo usa inspect y SELECT READ ONLY; no exporta Env ni rutas',()=>{
  const identity={database:'test',database_oid:'123',cluster_id:'456'},calls=[],docker={Id:'synthetic',Config:{Image:'postgres:17-alpine',Env:['SECRET=CANARY_PASSWORD']},Image:'sha256:synthetic',State:{Status:'running',Health:{Status:'healthy'}},HostConfig:{RestartPolicy:{Name:'unless-stopped'},PortBindings:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'54329'}]}},Mounts:[{Type:'volume',Name:'test_volume',Source:'CANARY_PRIVATE_PATH',Destination:'/var/lib/postgresql/data',RW:true}]};
  const r=A.dockerInspection('postgresql://synthetic:CANARY_PASSWORD@localhost/test',identity,{run:(bin,args)=>{calls.push({bin,args});return{status:0,stdout:JSON.stringify(args[0]==='inspect'?[docker]:identity)};}});assert.equal(r.postgres_identity_verified,true);assert.deepEqual(calls.map(c=>c.args[0]),['inspect','exec']);assert.match(calls[1].args.at(-1),/^BEGIN READ ONLY; SELECT /);assert.equal(JSON.stringify(r).includes('CANARY'),false);
});
test('A08. permisos POSIX y política Windows ACL protegen claves sin usar mode como ACL',async t=>{
  const {assertPrivatePath,privateWindowsAcl}=require('../backend/src/database/private-path'),root=C.temporaryRoot('ferraro-dbtest-'),file=path.join(root,'key');t.after(()=>C.removeTemporary(root));fs.writeFileSync(file,'synthetic',{mode:0o600});assertPrivatePath(file);
  const acl={owner:'S-1-5-21-123',current_user:'S-1-5-21-123',canonical:true,rules:[{sid:'S-1-5-21-123',allow:true,rights:2032127},{sid:'S-1-5-18',allow:true,rights:2032127},{sid:'S-1-5-32-544',allow:true,rights:2032127}]};
  assert.equal(privateWindowsAcl(acl),true);fs.chmodSync(file,0o666);assertPrivatePath(file,{platform:'win32',readAcl:()=>acl});if(process.platform!=='win32')assert.throws(()=>assertPrivatePath(file),/privada/);
  assert.throws(()=>assertPrivatePath(file,{platform:'win32',readAcl:()=>({...acl,rules:[...acl.rules,{sid:'S-1-1-0',allow:true,rights:1}]})}),/ACL/);assert.equal(privateWindowsAcl({...acl,rules:[]}),false);assert.equal(privateWindowsAcl({...acl,owner:'other'}),false);assert.equal(privateWindowsAcl({...acl,canonical:false}),false);
});
test('A09. checkout con autocrlf de Windows mantiene SHA-256 SQL gracias a eol=lf',t=>{
  const {spawnSync}=require('node:child_process'),root=C.temporaryRoot('ferraro-dbtest-');t.after(()=>C.removeTemporary(root));const relative='database/migrations/001_initial.sql',file=path.join(root,relative),original=fs.readFileSync(path.join(E.ROOT,relative));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,original);
  function git(args){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
  git(['init','-q']);git(['-c','core.autocrlf=false','add',relative]);fs.unlinkSync(file);git(['-c','core.autocrlf=true','checkout-index','--force','--all']);assert.notEqual(M.checksum(fs.readFileSync(file)),M.checksum(original),'reproduce el cambio sin atributos');
  fs.copyFileSync(path.join(E.ROOT,'.gitattributes'),path.join(root,'.gitattributes'));git(['add','.gitattributes']);fs.unlinkSync(file);git(['-c','core.autocrlf=true','checkout-index','--force','--all']);assert.equal(M.checksum(fs.readFileSync(file)),M.checksum(original));
});
test('A10. reiniciar PostgreSQL aislado conserva identidad, datos y versiones sin repetir migraciones',async t=>{
  const root=C.temporaryRoot('ferraro-dbtest-');let cluster,db;
  t.after(async()=>{if(db)await db.end();if(cluster)C.stopCluster(cluster);C.removeTemporary(root);});
  cluster=await C.startCluster(root);db=new Pool({connectionString:cluster.url,max:1});
  const ctx=await E.registerSynthetic(db,{environment:'test',purpose:'tests',url:cluster.url,file:path.join(root,'restart.json'),clusterDirectory:root});
  await M.migrate(db,ctx);await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Synthetic persistence only')",[crypto.randomUUID()]);const before=await snapshot(db),runs=(await db.query('SELECT count(*)::int n FROM ferraro_system.migration_runs')).rows[0].n;
  await db.end();db=null;C.stopCluster(cluster);cluster=await C.startCluster(root,{initialize:false,port:cluster.port});db=new Pool({connectionString:cluster.url,max:1});
  await E.validate(db,ctx);assert.deepEqual(await snapshot(db),before);assert.deepEqual(await M.migrate(db,ctx),[]);assert.equal((await db.query('SELECT count(*)::int n FROM ferraro_system.migration_runs')).rows[0].n,runs);
});
