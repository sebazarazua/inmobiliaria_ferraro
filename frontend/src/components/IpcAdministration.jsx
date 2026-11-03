import {useState} from 'react';
import {api,post} from '../api/client';
import {useApi} from '../hooks/useApi';
import {money} from '../utils/format';
import {Modal} from './Modal';

export function IpcAdministration({notify}) {
  const {data:source,reload}=useApi('ipc/latest');
  const {data:contracts}=useApi('contracts');
  const [contractId,setContractId]=useState(''),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[history,setHistory]=useState(null),[selectedIds,setSelectedIds]=useState([]),[batchResult,setBatchResult]=useState(null);
  async function refresh(){setBusy(true);setPreview(null);try{const result=await post('ipc/refresh',{});await reload({silent:true});notify(result.refresh.error||`IPC consultado. ${result.reconciliation.changed} cuotas actualizadas.`);}catch(error){notify(error.message);}finally{setBusy(false);}}
  async function simulate(){setBusy(true);setConfirmed(false);setSelectedIds([]);setBatchResult(null);try{setPreview(await post('ipc/reconciliation/simulate',{contract_id:contractId||null}));}catch(error){notify(error.message);}finally{setBusy(false);}}
  async function apply(){setBusy(true);try{const result=await post('ipc/reconciliation/apply',{contract_ids:selectedIds,tokens:Object.fromEntries(preview.contracts.map(c=>[c.id,c.token])),reason,interpretation_confirmed:confirmed});setBatchResult(result);setPreview(null);setConfirmed(false);setSelectedIds([]);notify(`Conciliación aplicada: ${result.changed} cuotas en ${result.applied} contratos. Pagos conservados.`);}catch(error){notify(error.message);setPreview(null);}finally{setBusy(false);}}
  async function showHistory(){setBusy(true);try{setHistory(await api(`contracts/${contractId}/adjustments`));}catch(error){notify(error.message);}finally{setBusy(false);}}
  const labels={ready:'Contrato listo para actualizar',review:'Requiere revisar condiciones',blocked:'Bloqueado: requiere revisión'};
  const selected=contracts?.find(c=>c.id===contractId);
  return <article className="card settings-card ipc-administration">
    <h3>IPC oficial y conciliación de alquileres</h3>
    <p>Último período almacenado: <strong>{source?.latestPeriod||'Sin datos'}</strong>{source?.latestIndex?` · índice ${source.latestIndex}`:''}</p>
    <p>{source?.source||'Todavía no se consultó INDEC.'}{source?.sourceUrl&&<> · <a href={source.sourceUrl} target="_blank" rel="noreferrer">Fuente</a></>}</p>
    {source?.last_success_at&&<p>Última consulta válida: {new Date(source.last_success_at).toLocaleString('es-AR')}. Actualización automática cada 12 horas.</p>}
    {source?.last_error&&<p role="status">La última consulta informó: {source.last_error}. Se conservan los índices válidos almacenados.</p>}
    <button type="button" className="button secondary" disabled={busy} onClick={refresh}>Consultar INDEC ahora</button>
    <p>La simulación incluye cuotas históricas, pagadas y futuras. Revisá los contratos y las diferencias antes de aplicar. Se conservan las correcciones manuales identificadas y las condonaciones. Verificá los acuerdos anteriores que el sistema no distinguía.</p>
    <label className="field"><span>Contrato a conciliar</span><select value={contractId} onChange={event=>{setContractId(event.target.value);setPreview(null);setConfirmed(false);}} disabled={busy}><option value="">Todos los contratos IPC</option>{contracts?.filter(c=>c.adjustment_index==='IPC').map(c=><option key={c.id} value={c.id}>{c.alias||c.code} · {c.property}</option>)}</select></label>
    {selected&&<details><summary>Cláusula conservada del contrato</summary><p>{selected.ipc_clause_text||'Consultá el PDF original y verificá la frecuencia y el rezago antes de confirmar.'}</p><p>Rezago {selected.ipc_lag_months||0}: {Math.max(1,selected.ipc_lag_months||0)} mes(es) antes del ajuste.</p></details>}
    <div className="pending-actions"><button type="button" className="button secondary" disabled={busy} onClick={simulate}>Simular conciliación</button><button type="button" className="button secondary" disabled={busy||!contractId} onClick={showHistory}>Ver historial de cálculos</button></div>
    {batchResult&&<div role="status"><p>{batchResult.applied} contratos incorporados · {batchResult.changed} cuotas actualizadas.</p>{batchResult.results.filter(r=>r.error).map(r=><p key={r.contract_id} role="alert">{contracts?.find(c=>c.id===r.contract_id)?.code||r.contract_id}: {r.error}</p>)}</div>}
    {preview&&<>
      <p role="status">{preview.count} cuotas examinadas · {preview.changed} cambios · {preview.blocked.length} bloqueadas.</p>
      {Object.entries(preview.totals).map(([currency,total])=><p key={currency}>Diferencia de canon: <strong>{money(total.canon_difference,currency)}</strong> · saldo conciliado: {money(total.balance,currency)}</p>)}
      <p>Seleccioná los contratos revisados para incorporar al cálculo automático. Cada contrato se aplica por separado; los bloqueados quedan pendientes.</p>
      <div className="pending-scroll"><table className="finance-table"><thead><tr><th>Incorporar</th><th>Contrato</th><th>Revisión</th><th>Actualización pendiente</th><th>Cuotas / cambios</th><th>Condiciones y aumentos históricos</th></tr></thead><tbody>{preview.contracts.map(c=><tr key={c.id}>
        <td><input type="checkbox" aria-label={`Incorporar ${c.alias||c.code}`} checked={selectedIds.includes(c.id)} disabled={busy||c.blocked.length>0||!c.changed} onChange={e=>{setSelectedIds(ids=>e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id));setConfirmed(false);}}/></td>
        <td>{c.alias||c.code}<small>{c.status}</small><a href={`#contracts?contract=${c.id}`}>Revisar contrato</a></td><td>{labels[c.classification]}{c.issues.map(issue=><small key={issue}>{issue}</small>)}</td>
        <td>{c.legacy_count} cuotas por incorporar · {c.pending_count} provisionales</td><td>{c.count} / {c.changed}{Object.entries(c.totals).map(([currency,t])=><small key={currency}>Diferencia: {money(t.canon_difference,currency)} · recibido: {money(t.paid_amount,currency)} · saldo/crédito: {money(t.balance,currency)}</small>)}</td>
        <td><details><summary>Ver condiciones e índices</summary><p>Inicio: {String(c.start_date).slice(0,10)} · fin: {String(c.end_date).slice(0,10)} · frecuencia: {c.frequency_months} meses · rezago: {c.lag_months||1} mes(es).</p><p>Canon inicial: {money(c.initial_amount,c.currency)} · canon actual: {c.current_amount?money(c.current_amount,c.currency):'Requiere revisión'}</p>{c.adjustments.map(step=><p key={step.effectivePeriod}>{step.effectivePeriod}: {money(step.amount,c.currency)} · base {step.basePeriod}: {step.baseIndex} · comparación {step.comparisonPeriod}: {step.targetIndex}</p>)}</details></td>
      </tr>)}</tbody></table></div>
      {preview.blocked.map(row=><p key={row.id} role="alert">{preview.contracts.find(c=>c.id===row.contract_id)?.code} {row.period||''}: {row.error}</p>)}
      <div className="pending-scroll"><table className="finance-table"><thead><tr><th>Contrato / período</th><th>Registrado</th><th>Contractual</th><th>Diferencia</th><th>A cobrar</th><th>Recibido</th><th>Saldo / crédito</th><th>Estado</th></tr></thead><tbody>{preview.rows.filter(row=>row.changed||row.legacy||Number(row.balance)!==0).map(row=><tr key={row.id}><td>{row.contract_code||row.contract_id}<small>{row.period}</small></td><td>{money(row.previous_amount,row.currency)}</td><td>{money(row.contractual_amount,row.currency)}</td><td>{money(Number(row.expected_amount)-Number(row.previous_amount),row.currency)}</td><td>{money(row.expected_amount,row.currency)}</td><td>{money(row.paid_amount,row.currency)}</td><td>{money(row.balance,row.currency)}</td><td>{row.adjustment_pending?'Provisional':row.status}</td></tr>)}</tbody></table></div>
      <label className="field"><span>Motivo de la conciliación</span><input value={reason} onChange={event=>setReason(event.target.value)} disabled={busy}/></label>
      <label className="checkbox-line"><input type="checkbox" aria-label="Confirmar revisión de contratos seleccionados" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy}/><span>Verifiqué las cláusulas originales, la frecuencia, el rezago y las diferencias de los contratos seleccionados. Confirmo su incorporación al cálculo automático.</span></label>
      <button type="button" className="button primary" disabled={busy||!confirmed||!reason.trim()||selectedIds.length===0} onClick={apply}>Aplicar conciliación revisada</button>
    </>}
    <Modal open={history!==null} title="Historial de cálculos IPC" onClose={()=>setHistory(null)}><div className="pending-scroll"><table className="finance-table"><thead><tr><th>Aplicación</th><th>Período</th><th>Versión</th><th>Anterior</th><th>Nuevo</th><th>Motivo / cálculo</th></tr></thead><tbody>{history?.map(row=><tr key={row.id}><td>{new Date(row.applied_at).toLocaleString('es-AR')}</td><td>{row.details_json.period}</td><td>{row.version}</td><td>{money(row.previous_amount,row.details_json.currency)}</td><td>{money(row.new_amount,row.details_json.currency)}</td><td>{row.reason}<details><summary>Ver trazabilidad</summary><pre>{JSON.stringify(row.details_json.calculation,null,2)}</pre></details></td></tr>)}</tbody></table></div>{history?.length===0&&<p>No hay cálculos aplicados para este contrato.</p>}</Modal>
  </article>;
}
