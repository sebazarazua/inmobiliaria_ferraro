import {useEffect,useState} from 'react';
import {patch,post} from '../api/client';
import {money} from '../utils/format';
import {FormField} from './FormField';
import {Modal} from './Modal';

export function ContractEditModal({contract,onClose,actions}) {
  const [form,setForm]=useState({}),[saving,setSaving]=useState(false),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false);
  useEffect(()=>{
    setPreview(null);setConfirmed(false);
    if(contract)setForm({alias:contract.alias||'',rental_type:contract.rental_type||'Residencial',duration_months:contract.duration_months||'',start_date:contract.start_date?.slice(0,10)||'',end_date:contract.end_date?.slice(0,10)||'',initial_amount:contract.initial_amount??'',deposit_amount:contract.deposit_amount??'',adjustment_frequency_months:contract.adjustment_frequency_months??'',adjustment_index:contract.adjustment_index||'',ipc_lag_months:contract.ipc_lag_months||0,ipc_clause_text:contract.ipc_clause_text||'',payment_due_day:contract.payment_due_day||10,management_fee_pct:contract.management_fee_pct||3,bank_name:contract.bank_name||'',cbu:contract.cbu||'',status:contract.status||'Activo',notes:contract.notes||''});
  },[contract]);
  if(!contract)return null;
  const change=event=>{setPreview(null);setConfirmed(false);setForm(current=>({...current,[event.target.name]:event.target.value}));};
  const ipc=contract.adjustment_index==='IPC'||form.adjustment_index==='IPC';
  async function submit(event){
    event.preventDefault();setSaving(true);
    try{
      if(ipc&&!preview){setPreview(await post('ipc/reconciliation/simulate',{contract_id:contract.id,contract_changes:{...form,ipc_clause_confirmed:confirmed}}));return;}
      await patch(`contracts/${contract.id}`,{...form,ipc_clause_confirmed:confirmed,reconciliation_token:preview?.token,interpretation_confirmed:confirmed});
      actions.notify('Contrato y cuotas actualizados.');actions.reload({silent:true});onClose();
    }catch(error){actions.notify(error.message);setPreview(null);}finally{setSaving(false);}
  }
  return <Modal open title="Editar contrato" subtitle={contract.code} onClose={onClose} footer={<><button className="button secondary" type="button" onClick={onClose}>Cancelar</button><button className="button primary" form="contract-edit-form" disabled={saving||(ipc&&preview&&(!confirmed||preview.blocked.length>0))}>{saving?'Guardando…':ipc&&!preview?'Simular cambios':ipc?'Confirmar cambios revisados':'Guardar cambios'}</button></>}>
    <form id="contract-edit-form" className="contract-edit-form" onSubmit={submit}>
      <FormField label="Alias" name="alias" value={form.alias} onChange={change}/>
      <FormField label="Tipo de alquiler" name="rental_type" as="select" value={form.rental_type} onChange={change} options={['Residencial','Comercial','Profesional','Temporario','Otro']}/>
      <FormField label="Inicio" name="start_date" type="date" value={form.start_date} onChange={change}/><FormField label="Fin" name="end_date" type="date" value={form.end_date} onChange={change}/>
      <FormField label="Duración (meses)" name="duration_months" type="number" min="1" value={form.duration_months} onChange={change}/>
      <FormField label="Canon inicial" name="initial_amount" type="number" min="0" step="0.01" value={form.initial_amount} onChange={change}/>
      <FormField label="Depósito" name="deposit_amount" type="number" min="0" step="0.01" value={form.deposit_amount} onChange={change}/>
      <FormField label="Honorario (%)" name="management_fee_pct" type="number" min="2" max="5" step="0.1" value={form.management_fee_pct} onChange={change}/>
      <FormField label="Ajuste cada (meses)" name="adjustment_frequency_months" type="number" min="1" value={form.adjustment_frequency_months} onChange={change}/>
      <FormField label="Índice" name="adjustment_index" as="select" value={form.adjustment_index} onChange={change} options={['','IPC','ICL','CAC','Acuerdo de partes']}/>
      <FormField label="Rezago IPC (0 y 1: mes anterior; 2: dos meses)" name="ipc_lag_months" type="number" min="0" max="2" value={form.ipc_lag_months} onChange={change}/>
      <FormField label="Día de vencimiento" name="payment_due_day" type="number" min="1" max="31" value={form.payment_due_day} onChange={change}/>
      <FormField label="Estado" name="status" value={form.status} readOnly disabled help="Se cambia desde «Ver acciones» (desactivar, finalizar, archivar…)."/>
      <FormField label="Banco" name="bank_name" value={form.bank_name} onChange={change}/><FormField label="CBU" name="cbu" value={form.cbu} onChange={change}/><FormField label="Notas" name="notes" as="textarea" value={form.notes} onChange={change} full/>
      {ipc&&<details className="full"><summary>Cláusula original conservada</summary><p>{form.ipc_clause_text||'Consultá el PDF original antes de confirmar la interpretación.'}</p></details>}
      {ipc&&<label className="checkbox-line full"><input type="checkbox" checked={confirmed} onChange={event=>{setConfirmed(event.target.checked);if(contract.ipc_clause_review_required)setPreview(null);}}/><span>Verifiqué la cláusula original y confirmo la frecuencia y el rezago.</span></label>}
      {preview&&<div className="full"><p>{preview.changed} cuotas cambiarían. Los pagos recibidos se conservan.</p>{preview.blocked.map(row=><p key={row.id} role="alert">{row.period}: {row.error}</p>)}<div className="pending-scroll"><table className="finance-table"><thead><tr><th>Período</th><th>Actual</th><th>Propuesto</th><th>Saldo</th></tr></thead><tbody>{preview.rows.filter(row=>row.changed||row.legacy).map(row=><tr key={row.id}><td>{row.period}</td><td>{money(row.previous_amount,row.currency)}</td><td>{money(row.expected_amount,row.currency)}</td><td>{money(row.balance,row.currency)}</td></tr>)}</tbody></table></div></div>}
    </form>
  </Modal>;
}
