const crypto=require('node:crypto');
const {uid}=require('../../database');
const {downloadOfficialSeries,INDEC_CSV_URL}=require('./source');
const REFRESH_MS=12*60*60*1000;
const LOCK='ferraro:ipc:write';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function loadStoredSeries(db) {
  const {rows}=await db.query('SELECT v.* FROM ipc_indices i JOIN ipc_index_versions v ON v.id=i.version_id ORDER BY i.period');
  return {series:new Map(rows.map(row=>[row.period,row])),latestPeriod:rows.at(-1)?.period||null,source:rows.at(-1)?.source||null};
}
async function latestIpcSummary(db) {
  const state=(await db.query('SELECT * FROM ipc_refresh_state WHERE singleton=true')).rows[0]||{};
  const latest=(await db.query('SELECT v.* FROM ipc_indices i JOIN ipc_index_versions v ON v.id=i.version_id ORDER BY i.period DESC LIMIT 1')).rows[0];
  return {...state,source:latest?.source||null,sourceUrl:latest?.source_url||null,distributionTitle:'IPC nacional · nivel general · diciembre 2016=100',latestPeriod:latest?.period||null,latestVariation:latest?.monthly_variation==null?null:Number(latest.monthly_variation),latestIndex:latest?.index_value||null,stale:!state.last_success_at||Date.now()-new Date(state.last_success_at).getTime()>REFRESH_MS};
}
async function refreshOfficialIndices(db,{force=false,fetchImpl,now=new Date()}={}) {
  const client=await db.connect();let acquired=false,inTransaction=false;
  try{
    acquired=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) locked',['ferraro:ipc:refresh'])).rows[0].locked;
    if(!acquired)return {skipped:true,reason:'refresh_in_progress'};
    const state=(await client.query('SELECT * FROM ipc_refresh_state WHERE singleton=true')).rows[0];
    const elapsed=state?.last_attempt_at?now-new Date(state.last_attempt_at):Infinity;
    if(elapsed<(force?60000:REFRESH_MS))return {skipped:true,reason:'not_due'};
    await client.query('UPDATE ipc_refresh_state SET last_attempt_at=$1 WHERE singleton=true',[now]);
    try{
      // Network I/O holds only a dedicated refresh lock, never financial row locks.
      const downloaded=await downloadOfficialSeries(fetchImpl),latest=downloaded.records.at(-1).period;
      if(state?.latest_period&&latest<state.latest_period)throw new Error(`Fuente atrasada (${latest}); se conserva ${state.latest_period}.`);
      await client.query('BEGIN');inTransaction=true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
      let changed=0;
      for(const record of downloaded.records){
        const contentHash=hash({value:record.value,source:downloaded.sourceUrl});
        const current=(await client.query('SELECT v.content_hash,v.source_url FROM ipc_indices i JOIN ipc_index_versions v ON v.id=i.version_id WHERE i.period=$1',[record.period])).rows[0];
        // An alternative source may fill missing months, never revise an INDEC level.
        if(downloaded.sourceUrl!==INDEC_CSV_URL&&current?.source_url===INDEC_CSV_URL)continue;
        if(current?.content_hash===contentHash)continue;
        const version=(await client.query(`INSERT INTO ipc_index_versions(id,period,index_value,monthly_variation,source,source_url,fetched_at,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(period,content_hash) DO UPDATE SET content_hash=excluded.content_hash RETURNING id`,[uid(),record.period,record.value,record.variation,downloaded.source,downloaded.sourceUrl,now,contentHash])).rows[0];
        await client.query('INSERT INTO ipc_indices(period,version_id) VALUES($1,$2) ON CONFLICT(period) DO UPDATE SET version_id=excluded.version_id',[record.period,version.id]);changed++;
      }
      await client.query('UPDATE ipc_refresh_state SET last_success_at=$1,last_error=$2,latest_period=$3,source_url=$4 WHERE singleton=true',[now,downloaded.warnings.join(' | ')||null,latest,downloaded.sourceUrl]);
      await client.query('COMMIT');inTransaction=false;
      return {changed,latestPeriod:latest,sourceUrl:downloaded.sourceUrl,warnings:downloaded.warnings};
    }catch(error){
      if(inTransaction){await client.query('ROLLBACK');inTransaction=false;}
      await client.query('UPDATE ipc_refresh_state SET last_error=$1 WHERE singleton=true',[error.message]);
      return {error:error.message,retainedStoredData:true};
    }
  }finally{
    try{
      if(inTransaction)await client.query('ROLLBACK');
      if(acquired)await client.query('SELECT pg_advisory_unlock(hashtext($1))',['ferraro:ipc:refresh']);
    }finally{client.release();}
  }
}
module.exports={LOCK,REFRESH_MS,hash,loadStoredSeries,latestIpcSummary,refreshOfficialIndices};
