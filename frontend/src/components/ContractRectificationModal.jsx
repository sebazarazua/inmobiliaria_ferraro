import {useEffect,useState} from 'react';
import {api,post} from '../api/client';
import {Modal} from './Modal';
import {FormField} from './FormField';
import {AdjustmentFields} from './ContractTermsFields';
import {CONTRACT_LABELS,conditionValue} from './ContractConditions';
import {money} from '../utils/format';
export function ContractRectificationModal({contract,onClose,actions}){
  const [policy,setPolicy]=useState(null),[form,setForm]=useState({}),[reason,setReason]=useState(''),[reference,setReference]=useState(''),[quote,setQuote]=useState(''),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!contract)return;let active=true;setPolicy(null);setPreview(null);setConfirmed(false);setReason('');setReference('');setQuote('');setError('');
    api(`contracts/${contract.id}/protection`).then(data=>{if(active){setPolicy(data);const c=data.contract;setForm(Object.fromEntries(['initial_amount','adjustment_type','adjustment_index','adjustment_frequency_months','adjustment_value_pct','ipc_lag_months','ipc_clause_text','ipc_clause_review_required','notes'].map(k=>[k,c[k]])));}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
  },[contract]);
  if(!contract)return null;
  function change(patch){setForm(current=>({...current,...patch}));setPreview(null);setConfirmed(false);}
  const input=()=>({operation:'original_document_correction',document_id:policy.document.id,reason,document_reference:reference,document_quote:quote,changes:form});
  async function simulate(event){event.preventDefault();setBusy(true);setError('');setConfirmed(false);try{setPreview(await post(`contracts/${contract.id}/rectification/simulate`,input()));}catch(e){setPreview(null);setError(e.message);}finally{setBusy(false);}}
  async function apply(){setBusy(true);setError('');try{const result=await post(`contracts/${contract.id}/rectification/apply`,{...input(),token:preview.token,confirm:true});actions.notify(`Rectificación documental registrada. Versión ${result.version}; ${result.changed} cuotas revisadas. Pagos conservados.`);actions.reload({silent:true});onClose();}catch(e){setError(e.message);setPreview(null);setConfirmed(false);}finally{setBusy(false);}}
  const invalidate=setter=>event=>{setter(event.target.value);setPreview(null);setConfirmed(false);};
  return <Modal open title="Rectificar datos del contrato" subtitle={contract.code} onClose={onClose} footer={<><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" form="contract-rectification-form" disabled={busy||!policy?.document?.available}>Simular rectificación</button>{preview&&<button type="button" className="button primary" disabled={busy||!confirmed||preview.blocked.length>0} onClick={apply}>Aplicar rectificación documentada</button>}</>}>
    <p>Solo para corregir datos que no coinciden con el contrato original. No autoriza pactar nuevas condiciones, incorporar una adenda ni reemplazar una renovación.</p>
    {error&&<p role="alert">{error}</p>}
    {!policy&&!error&&<p role="status">Verificando el documento original…</p>}
    {policy&&<><form id="contract-rectification-form" className="form-grid" onSubmit={simulate}>
      {policy.document?.available?<p className="full"><a href={`/api/document-admin/file?document_id=${policy.document.id}`} target="_blank" rel="noreferrer">Consultar PDF original: {policy.document.filename}</a></p>:<p className="notice full" role="alert">No hay un PDF original asociado y disponible. No se permite rectificar con un adjunto posterior o sin evidencia verificable.</p>}
      <FormField label="Motivo de la rectificación" name="rectification_reason" as="textarea" full required minLength="10" value={reason} onChange={invalidate(setReason)}/>
      <FormField label="Referencia a la cláusula y página del PDF original" name="document_reference" full required minLength="3" value={reference} onChange={invalidate(setReference)}/>
      <FormField label="Fragmento textual del contrato original" name="document_quote" as="textarea" full required minLength="20" value={quote} onChange={invalidate(setQuote)} help="Se verifica contra el contenido del PDF. No alcanza con marcar una confirmación."/>
      <FormField label="Canon inicial correcto según el PDF" name="initial_amount" type="number" min="0" step="0.01" value={form.initial_amount??''} required onChange={event=>change({initial_amount:event.target.value})}/>
      <AdjustmentFields key={contract.id} form={form} onChange={change}/>
      {form.adjustment_index==='IPC'&&<><FormField label="Cláusula IPC conservada" name="ipc_clause_text" as="textarea" full value={form.ipc_clause_text??''} onChange={event=>change({ipc_clause_text:event.target.value})}/><label className="checkbox-line full"><input type="checkbox" checked={Boolean(form.ipc_clause_review_required)} onChange={event=>change({ipc_clause_review_required:event.target.checked})}/>La cláusula todavía requiere revisión adicional.</label></>}
      <p className="full">Moneda, vigencia, vencimientos, punitorios, partes y otras condiciones permanecen protegidos. Si su impacto no puede simularse con el motor actual, no se permite aplicarlos. La modificación por adenda queda pendiente de un circuito documental específico.</p>
    </form>
    {preview&&<section className="rectification-preview"><h3>Comparación con los datos registrados</h3><dl>{preview.comparison.map(item=><div key={item.field}><dt>{CONTRACT_LABELS[item.field]||'Condición contractual'}</dt><dd>{conditionValue(item.field,item.before,contract.currency)} → {conditionValue(item.field,item.proposed,contract.currency)}</dd></div>)}</dl><p>{preview.count} cuotas examinadas · {preview.changed} cambios previstos.</p>{preview.blocked.map((item,index)=><p role="alert" key={index}>{item.period||''} {item.error}</p>)}<div className="pending-scroll"><table className="finance-table"><thead><tr><th>Período</th><th>Anterior</th><th>Propuesto</th><th>Recibido</th><th>Saldo / crédito</th></tr></thead><tbody>{preview.rows.filter(row=>row.changed||row.legacy).map(row=><tr key={row.id}><td>{row.period}</td><td>{money(row.previous_amount,row.currency)}</td><td>{money(row.expected_amount,row.currency)}</td><td>{money(row.paid_amount,row.currency)}</td><td>{money(row.balance,row.currency)}</td></tr>)}</tbody></table></div><label className="checkbox-line"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Cotejé el documento original y las diferencias. Confirmo que corrijo un error de carga, sin introducir condiciones nuevas ni una adenda.</label></section>}
    {policy.history.length>0&&<details><summary>Historial de rectificaciones ({policy.history.length})</summary><ol>{policy.history.map(item=><li key={item.id}><strong>Versión {item.details_json.version} · {new Date(item.created_at).toLocaleString('es-AR')}</strong><p>{item.details_json.actor?.label||'Actor no registrado'} · {item.details_json.reason}</p><p>{item.details_json.evidence?.filename} · {item.details_json.evidence?.reference}</p><ul>{(item.details_json.comparison||[]).map(change=><li key={change.field}>{CONTRACT_LABELS[change.field]||'Condición contractual'}: {conditionValue(change.field,change.before,contract.currency)} → {conditionValue(change.field,change.proposed,contract.currency)}</li>)}</ul></li>)}</ol></details>}
    </>}
  </Modal>;
}
