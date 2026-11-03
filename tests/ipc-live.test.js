require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {openDatabase,uid}=require('../backend/src/database');
const {refreshOfficialIndices,latestIpcSummary}=require('../backend/src/modules/ipc/store');
const {INDEC_CSV_URL}=require('../backend/src/modules/ipc/source');
const {generateInstallments,reconcileInstallments}=require('../backend/src/modules/rent');
const {createApp}=require('../backend/src/app');

test('INDEC real → índices PostgreSQL → contrato antiguo → cuotas → API → conciliación',async()=>{
  const db=await openDatabase();let app;
  try{
    await db.query('UPDATE ipc_refresh_state SET last_attempt_at=NULL');
    const refresh=await refreshOfficialIndices(db,{force:true});assert.ok(!refresh.error,JSON.stringify(refresh));assert.equal(refresh.sourceUrl,INDEC_CSV_URL);
    const summary=await latestIpcSummary(db);assert.ok(summary.latestPeriod>='2026-09');
    const count=Number((await db.query('SELECT COUNT(*) n FROM ipc_indices')).rows[0].n);assert.ok(count>=118);
    const owner=uid(),tenant=uid(),property=uid(),contract=uid();
    await db.query('INSERT INTO persons(id,full_name) VALUES($1,$2),($3,$4)',[owner,'Propietario verificación',tenant,'Inquilino verificación']);
    await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES($1,'LIVE-IPC','Verificación IPC 123','verificacion ipc 123','Departamento','Alquilada')",[property]);
    await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_index,adjustment_frequency_months,ipc_lag_months,ipc_clause_text) VALUES($1,'LIVE-IPC',$2,$3,'Residencial',24,'2025-11-01','2027-10-31',400000,'ARS','IPC',3,1,'IPC trimestral con un mes de rezago.')",[contract,property,tenant]);
    await db.query('INSERT INTO contract_owners(contract_id,person_id) VALUES($1,$2)',[contract,owner]);
    const client=await db.connect();try{await client.query('BEGIN');await generateInstallments(client,(await client.query('SELECT * FROM contracts WHERE id=$1',[contract])).rows[0]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const rows=(await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY period',[contract])).rows;
    assert.equal(rows.find(r=>r.period==='2026-02').expected_amount,'433701.80');assert.equal(rows.find(r=>r.period==='2026-08').expected_amount,'502980.71');
    app=await createApp({db});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
    const pending=await fetch(`${base}/api/pending-collections`).then(r=>r.json());assert.equal(pending.find(r=>r.period==='2026-08').expected_amount,502980.71);
    const april=rows.find(r=>r.period==='2026-04');const payment=await fetch(`${base}/api/payments/${april.id}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:400000,paid_at:'2026-04-10'})}).then(r=>r.json());assert.equal(payment.status,'Parcial');
    const paymentsBefore=(await db.query('SELECT * FROM payments ORDER BY id')).rows;
    const simulation=await reconcileInstallments(db,{contractId:contract});const difference=simulation.rows.find(r=>r.id===april.id);assert.equal(difference.balance,'33701.80');
    assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows,paymentsBefore);
    fs.mkdirSync(path.join(__dirname,'..','tmp'),{recursive:true});
    const report={verifiedAt:new Date().toISOString(),database:'isolated temporary PostgreSQL',source:refresh,storedIndexCount:count,summary,contract:contract,amounts:rows.map(r=>({period:r.period,amount:r.expected_amount,pending:r.adjustment_pending})),simulation:{mode:simulation.mode,count:simulation.count,totals:simulation.totals,paidExample:difference},paymentsUntouched:true};
    fs.writeFileSync(path.join(__dirname,'..','tmp','ipc-live-verification.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({source:summary.sourceUrl,latestPeriod:summary.latestPeriod,storedIndices:count,installments:rows.length,exampleAugust:pending.find(r=>r.period==='2026-08').expected_amount,simulationBalance:difference.balance}));
  }finally{if(app)await new Promise(r=>app.server.close(r));await db.end();}
});
