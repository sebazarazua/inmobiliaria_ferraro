import {useEffect,useState} from 'react';
import {api} from '../api/client';
import {Modal} from './Modal';
import {money,shortDate} from '../utils/format';
import {formatPeriod} from '../utils/periods.mjs';
import {updateLabel,nextAdjustmentPeriod} from '../utils/contract-options.mjs';

const reasons={contract_created:'Creación del contrato',contract_imported:'Importación del contrato',official_indices_updated:'Actualización de índices oficiales',manual_collection_edit:'Corrección manual',contract_conditions_updated:'Condiciones contractuales revisadas'};
const numeric=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const coefficient=value=>numeric(value)?Number(value).toLocaleString('es-AR',{maximumFractionDigits:8}):'No registrado';
const indexLabel=value=>numeric(value)?Number(value).toLocaleString('es-AR',{maximumFractionDigits:10}):'No registrado';
const officialLink=value=>/^https?:\/\//i.test(value||'')?value:null;

export function RentDetailModal({row,onClose}){
  const[history,setHistory]=useState({loading:true,rows:[],error:null}),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!row)return;
    let active=true;setHistory({loading:true,rows:[],error:null});
    api(`contracts/${row.contract_id}/adjustments`).then(rows=>{if(active)setHistory({loading:false,rows:rows.filter(item=>item.installment_id===row.id).sort((a,b)=>a.version-b.version),error:null});}).catch(()=>{if(active)setHistory({loading:false,rows:[],error:'No pudimos consultar las versiones del alquiler. El importe y los cobros no se modificaron.'});});
    return()=>{active=false;};
  },[row?.id,row?.contract_id,retry]);
  if(!row)return null;
  const ipc=row.adjustment_index==='IPC',calculation=ipc?row.calculation_json||{}:{},steps=Array.isArray(calculation.steps)?[...calculation.steps].sort((a,b)=>a.effectivePeriod.localeCompare(b.effectivePeriod)):[];
  const manual=row.rent_override_amount!=null||row.rent_forgiven;
  const requiresReconciliation=ipc&&(row.ipc_requires_reconciliation||row.ipc_managed===false);
  const provisional=ipc&&row.adjustment_pending;
  const missing=calculation.missingPeriods||[];
  const frequency=calculation.frequencyMonths??row.adjustment_frequency_months;
  const lag=calculation.referenceOffsetMonths??Math.max(1,Number(row.ipc_lag_months||0));
  const next=nextAdjustmentPeriod({...row,adjustment_frequency_months:frequency},row.period);
  const last=steps.at(-1),sourceUrl=officialLink(last?.sourceUrl);
  return <Modal open title={`Detalle del alquiler — ${formatPeriod(row.period)}`} onClose={onClose} footer={<button type="button" className="button secondary" onClick={onClose}>Cerrar</button>}>
    <div className="rent-detail">
      <header className="rent-detail-total"><span>Importe utilizado en {formatPeriod(row.period).toLowerCase()}</span><strong>{money(row.expected_amount,row.currency)}</strong>{manual&&<span className="ipc-pending">Importe manual</span>}</header>
      <dl className="rent-detail-grid"><div><dt>Propiedad</dt><dd>{row.property||'No registrada'}</dd></div><div><dt>Contrato</dt><dd>{row.contract_alias||row.contract_code}</dd></div><div><dt>Inquilino</dt><dd>{row.tenant||'No registrado'}</dd></div><div><dt>Canon inicial</dt><dd>{money(row.initial_amount,row.currency)}</dd></div><div><dt>Canon contractual del período</dt><dd>{row.contractual_amount!=null?money(row.contractual_amount,row.currency):'Pendiente de revisión'}</dd></div>{manual&&<div><dt>Importe aplicado por corrección manual</dt><dd>{money(row.expected_amount,row.currency)}</dd></div>}<div><dt>Actualización acordada</dt><dd>{updateLabel(row)}</dd></div><div><dt>Frecuencia contractual</dt><dd>{frequency?`Cada ${frequency} meses`:'No registrada'}</dd></div>{ipc&&<div><dt>Mes de IPC utilizado</dt><dd>{lag===1?'Mes anterior al ajuste':`${lag} meses anteriores`}</dd></div>}</dl>
      {requiresReconciliation&&<p className="notice" role="status">Este contrato histórico requiere conciliación. El importe registrado se conserva hasta revisar e incorporar sus cuotas desde Configuración.</p>}
      {provisional&&<p className="notice" role="status">El importe es provisional. {missing.length?`Falta publicar o incorporar el IPC de ${missing.map(formatPeriod).join(', ')}.`:'Falta un índice oficial requerido para este período.'} Se conserva el último canon válido disponible.</p>}
      {!ipc&&<p className="notice" role="status">La actualización de este contrato requiere intervención manual. No se aplica el motor IPC ni se presenta un historial de aumentos de INDEC.</p>}
      {!ipc&&row.adjustment_type==='FIXED_PERCENTAGE'&&row.adjustment_value_pct!=null&&<p>Porcentaje fijo acordado: {Number(row.adjustment_value_pct).toLocaleString('es-AR')} %.</p>}
      {!ipc&&row.notes&&<section><h3>Condiciones conservadas</h3><p className="rent-detail-notes">{row.notes}</p></section>}
      {ipc&&<section><h3>Historial de aumentos del período</h3>{steps.length?<ol className="rent-adjustment-list">{steps.map(step=><li key={step.effectivePeriod}><div><strong>Desde {formatPeriod(step.effectivePeriod).toLowerCase()}</strong><b>{money(step.amount,row.currency)}</b></div><p>Coeficiente acumulado: {coefficient(step.coefficient)}{numeric(step.coefficient)&&Number(step.coefficient)>0?` · aumento acumulado ${((Number(step.coefficient)-1)*100).toLocaleString('es-AR',{maximumFractionDigits:4})} %`:''}</p></li>)}</ol>:<p>{requiresReconciliation?'Todavía no hay una reconstrucción histórica revisada para esta cuota.':'Todavía no hay aumentos aplicados en el cálculo de este período.'}</p>}{!steps.length&&!requiresReconciliation&&next&&<p>Próximo período de ajuste contractual: {formatPeriod(next).toLowerCase()}. Su importe dependerá de los datos oficiales disponibles.</p>}</section>}
      {ipc&&<details className="rent-detail-technical"><summary>Índices y fuente del cálculo</summary>{steps.length?<><div className="pending-scroll"><table className="finance-table"><thead><tr><th>Aumento efectivo</th><th>Período base</th><th>IPC base</th><th>Comparación</th><th>IPC utilizado</th></tr></thead><tbody>{steps.map(step=><tr key={step.effectivePeriod}><td>{formatPeriod(step.effectivePeriod)}</td><td>{step.basePeriod}</td><td title={String(step.baseIndex)}>{indexLabel(step.baseIndex)}</td><td>{step.comparisonPeriod}</td><td title={String(step.targetIndex)}>{indexLabel(step.targetIndex)}</td></tr>)}</tbody></table></div><p>Fuente: {last?.source||'No registrada'}{sourceUrl&&<> · <a href={sourceUrl} target="_blank" rel="noreferrer">Consultar fuente oficial</a></>}</p></>:<p>No hay índices utilizados registrados para este cálculo. No se descargan nuevos datos al abrir esta ventana.</p>}<p>Los datos corresponden al cálculo guardado de esta cuota.</p></details>}
      <section><h3>Versiones de este alquiler</h3>{history.loading?<p role="status">Consultando el historial guardado…</p>:history.error?<div role="status"><p>{history.error}</p><button type="button" className="button secondary" onClick={()=>setRetry(value=>value+1)}>Reintentar consulta</button></div>:history.rows.length?<ol className="rent-version-list">{history.rows.map(item=><li key={item.id}><strong>Versión {item.version} · {shortDate(item.applied_at)}</strong><span>{money(item.previous_amount,row.currency)} → {money(item.new_amount,row.currency)}</span><small>{reasons[item.reason]||item.reason}</small></li>)}</ol>:<p>No hay versiones registradas para esta cuota.</p>}</section>
    </div>
  </Modal>;
}
