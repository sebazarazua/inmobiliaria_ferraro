// Read-only diagnostic of a Ferraro database. It never migrates or writes: one READ ONLY transaction.
// Output is aggregates and technical identifiers only (no names, documents, phones or bank data).
// Usage: DATABASE_URL=postgresql://... node backend/scripts/diagnose-database.js [--json]
const fs=require('node:fs'),path=require('node:path');
const {Pool}=require('pg');
const {balance,scaled,decimal}=require('../src/lib/money');
const MIGRATIONS=path.resolve(__dirname,'..','..','database','migrations');
const LIST_LIMIT=20;

async function diagnose(connectionString){
  const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000}),client=await pool.connect(),report={generated_at:new Date().toISOString(),checks:{}};
  const q=async(sql,params=[])=>(await client.query(sql,params)).rows;
  const exists=async table=>(await q('SELECT to_regclass($1) IS NOT NULL ok',[table]))[0].ok;
  const column=async(table,name)=>(await q('SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2',[table,name])).length>0;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const files=fs.readdirSync(MIGRATIONS).filter(f=>f.endsWith('.sql')).sort();
    const applied=(await exists('schema_migrations'))?(await q('SELECT version FROM schema_migrations ORDER BY version')).map(r=>r.version):[];
    report.migrations={applied_count:applied.length,latest_applied:applied.at(-1)||null,pending:files.filter(f=>!applied.includes(f)),unknown_applied:applied.filter(v=>!files.includes(v))};
    const has={services:await exists('installment_services'),lateFees:await column('installments','late_fee_calculated_amount'),responsibility:await column('ledger_entries','responsibility'),syncDays:await exists('late_fee_sync_days'),rates:await exists('late_fee_rates'),findings:await exists('integrity_findings')};
    report.counts={
      contracts_by_status:Object.fromEntries((await q('SELECT status,COUNT(*)::int n FROM contracts GROUP BY 1 ORDER BY 1')).map(r=>[r.status,r.n])),
      installments_by_status:Object.fromEntries((await q('SELECT status,COUNT(*)::int n FROM installments GROUP BY 1 ORDER BY 1')).map(r=>[r.status,r.n])),
      payments_by_currency:await q('SELECT i.currency,COUNT(*)::int payments,SUM(p.amount)::text total FROM payments p JOIN installments i ON i.id=p.installment_id GROUP BY 1 ORDER BY 1'),
      service_charges_by_status:has.services?Object.fromEntries((await q('SELECT status,COUNT(*)::int n FROM installment_services GROUP BY 1 ORDER BY 1')).map(r=>[r.status,r.n])):'tabla inexistente (migración 015 pendiente)',
      expenses_by_responsibility:has.responsibility?await q(`SELECT responsibility,currency,COUNT(*)::int n,SUM(amount)::text total,COUNT(*) FILTER (WHERE voided_at IS NOT NULL)::int voided FROM ledger_entries WHERE kind='Gasto' GROUP BY 1,2 ORDER BY 1,2`):'columna inexistente (migración 017 pendiente)',
      linked_expenses:has.services?(await q('SELECT COUNT(DISTINCT expense_id)::int n FROM installment_services WHERE expense_id IS NOT NULL'))[0].n:0
    };
    const ids=rows=>rows.slice(0,LIST_LIMIT).map(r=>r.id);
    const servicesSum=has.services?`COALESCE((SELECT SUM(s.original_amount-s.forgiven_amount) FROM installment_services s WHERE s.installment_id=i.id AND s.status='Confirmado'),0)`:'0';
    const installments=await q(`SELECT i.id,i.status,i.currency,i.adjustment_pending,i.expected_amount,i.vat_amount,i.late_fee_amount,i.discount_amount,${has.services?'i.services_amount':'0 services_amount'},${servicesSum}::text services_sum,c.currency contract_currency,
      (COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid FROM installments i JOIN contracts c ON c.id=i.contract_id`);
    const negative=[],paidWithDebt=[],openWithoutDebt=[],currency=[],projection=[];
    for(const row of installments){
      const value=scaled(balance(row,row.paid));
      if(value<0n)negative.push(row);
      if(row.status==='Pagado'&&value>0n)paidWithDebt.push(row);
      if(['Pendiente','Parcial'].includes(row.status)&&value<=0n&&!row.adjustment_pending)openWithoutDebt.push(row);
      if(row.currency!==row.contract_currency)currency.push(row);
      if(has.services&&scaled(row.services_amount)!==scaled(row.services_sum))projection.push(row);
    }
    const creditTotals={};for(const row of negative)creditTotals[row.currency]=(creditTotals[row.currency]||0n)-scaled(balance(row,row.paid));
    const credits=Object.fromEntries(Object.entries(creditTotals).map(([key,value])=>[key,decimal(value)]));
    report.checks.negative_balances={count:negative.length,credit_by_currency:credits,installment_ids:ids(negative),note:'Saldo a favor del inquilino (crédito). Requiere conciliación si no tiene operación de crédito confirmada.'};
    report.checks.paid_status_with_debt={count:paidWithDebt.length,installment_ids:ids(paidWithDebt)};
    report.checks.open_status_without_debt={count:openWithoutDebt.length,installment_ids:ids(openWithoutDebt)};
    report.checks.installment_currency_mismatch={count:currency.length,installment_ids:ids(currency)};
    report.checks.services_projection_mismatch=has.services?{count:projection.length,installment_ids:ids(projection)}:'no aplica';
    if(has.services){
      const dup=await q('SELECT expense_id id,COUNT(*)::int n FROM installment_services WHERE expense_id IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1');
      report.checks.duplicate_expense_links={count:dup.length,expense_ids:ids(dup),unique_index:(await q("SELECT 1 FROM pg_indexes WHERE indexname='installment_services_expense_uq'")).length>0};
      const cross=await q('SELECT s.id FROM installment_services s JOIN installments i ON i.id=s.installment_id LEFT JOIN ledger_entries l ON l.id=s.expense_id WHERE s.currency<>i.currency OR (l.id IS NOT NULL AND l.currency<>s.currency)');
      report.checks.charge_currency_mismatch={count:cross.length,charge_ids:ids(cross)};
      const ownerCharged=has.responsibility?await q("SELECT s.id FROM installment_services s JOIN ledger_entries l ON l.id=s.expense_id WHERE s.status='Confirmado' AND l.responsibility IN ('owner','agency')"):[];
      report.checks.owner_expense_charged_to_tenant={count:ownerCharged.length,charge_ids:ids(ownerCharged)};
    }
    if(has.findings)report.checks.open_integrity_findings=(await q('SELECT check_name,COUNT(*)::int n FROM integrity_findings WHERE resolved_at IS NULL GROUP BY 1'));
    if(has.rates){
      const r=(await q("SELECT COUNT(*)::int intervals,MIN(valid_from)::text first_day,MAX(valid_until)::text until_exclusive FROM late_fee_rates"))[0];
      report.bna={...r,sync_state:(await exists('late_fee_sync_state'))?(await q('SELECT status,checked_at,successful_at FROM late_fee_sync_state'))[0]||null:null,
        sync_days:has.syncDays?Object.fromEntries((await q('SELECT status,COUNT(*)::int n FROM late_fee_sync_days GROUP BY 1')).map(x=>[x.status,x.n])):'tabla inexistente (migración 018 pendiente)'};
    }
    const documents=await q('SELECT id,absolute_path FROM documents');
    const missing=documents.filter(d=>!d.absolute_path||!fs.existsSync(d.absolute_path));
    report.documents={total:documents.length,missing_file:missing.length,missing_document_ids:ids(missing)};
    await client.query('ROLLBACK');
    return report;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();await pool.end();}
}
if(require.main===module){
  if(!process.env.DATABASE_URL){console.error('Definí DATABASE_URL explícitamente para la base a diagnosticar.');process.exit(1);}
  const target=new URL(process.env.DATABASE_URL);
  console.error(`Diagnóstico de solo lectura: ${target.hostname}:${target.port||5432}${target.pathname}`);
  diagnose(process.env.DATABASE_URL).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={diagnose};
