const {allSettings,uid}=require('../../database');
const {reason,actor}=require('./common');
const {validateTerms,calculate}=require('./engine');
async function readPolicy(db){const s=await allSettings(db);return s.late_fee_policy?JSON.parse(s.late_fee_policy):{mode:'manual',informational:true};}
async function savePolicy(db,input){
  if(!['manual','none','fixed','bna'].includes(input.mode)||input.confirm!==true)throw new Error('Elegí y confirmá una política administrativa.');
  const why=reason(input.reason);let terms=null;if(['fixed','bna'].includes(input.mode)){terms=validateTerms(input.terms);if(terms.type!==(input.mode==='fixed'?'FIXED_DAILY':'BANK_ACTIVE_RATE'))throw new Error('La modalidad no coincide.');}
  const policy={mode:input.mode,terms,informational:true,reason:why,actor,updated_at:new Date().toISOString()},client=await db.connect();try{await client.query('BEGIN');await client.query("INSERT INTO settings(key,value) VALUES('late_fee_policy',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(policy)]);await client.query("INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,'setting',$1,'late_fee_policy_changed',$2)",[uid(),JSON.stringify(policy)]);await client.query('COMMIT');return policy;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function informational(db,id,input){
  const policy=await readPolicy(db);if(!policy.terms)throw new Error('La política no propone una tasa calculable.');
  const client=await db.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const row=(await client.query('SELECT * FROM installments WHERE id=$1',[id])).rows[0];if(!row)throw new Error('Cuota no encontrada.');const contract=(await client.query('SELECT * FROM contracts WHERE id=$1',[row.contract_id])).rows[0],payments=(await client.query('SELECT * FROM payments WHERE installment_id=$1',[id])).rows,rates=(await client.query('SELECT r.*,s.url,s.content_hash FROM late_fee_rates r JOIN late_fee_rate_sources s ON s.id=r.source_id')).rows;
    const calculation=calculate({contract,installment:row,payments,rates,cutoff:input.cutoff,review:{id:null,terms_json:policy.terms,evidence_json:{origin:'internal_policy_not_obligation'}}});await client.query('ROLLBACK');return{informational:true,exigible:false,message:'Estimación administrativa sin fundamento contractual/jurídico revisado. No integra el Debe ni permite aplicar un cargo.',calculation};
  }finally{await client.query('ROLLBACK');client.release();}
}
module.exports={readPolicy,savePolicy,informational};
