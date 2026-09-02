import {useEffect,useMemo,useState} from 'react';
import {api,post} from '../api/client';
import {Modal} from './Modal';
import {money,today} from '../utils/format';

const emptyForm={payment_type:'Alquiler',paid_at:today(),mode:'specific',contract_id:'',installment_id:'',amount_mode:'full',amount:'',method:'Transferencia',account_name:'',tax_status:'Declarado',notes:''};

export function PaymentModal({installment,onClose,onSaved,notify}){
  const[form,setForm]=useState(emptyForm),[pending,setPending]=useState([]),[saving,setSaving]=useState(false);
  useEffect(()=>{if(!installment)return;api('pending-collections').then(rows=>{setPending(rows);if(installment.id)setForm(current=>({...current,contract_id:installment.contract_id||'',installment_id:installment.id,amount:String(installment.due_amount||installment.expected_amount||'')}));else setForm(emptyForm);}).catch(error=>notify(error.message));},[installment,notify]);
  const contracts=useMemo(()=>[...new Map(pending.map(item=>[item.contract_id,{id:item.contract_id,label:item.contract_alias||item.contract_code||item.property}])).values()],[pending]);
  const installments=useMemo(()=>pending.filter(item=>!form.contract_id||item.contract_id===form.contract_id),[pending,form.contract_id]);
  const selected=installments.find(item=>item.id===form.installment_id);
  useEffect(()=>{if(form.amount_mode==='full'&&selected)setForm(current=>({...current,amount:String(selected.due_amount||selected.expected_amount||'')}));},[selected,form.amount_mode]);
  function change(event){const{name,value,type,checked}=event.target;setForm(current=>({...current,[name]:type==='checkbox'?checked:value,...(name==='contract_id'?{installment_id:'',amount:''}:{}),...(name==='amount_mode'&&value==='partial'?{amount:''}:{})}));}
  async function submit(event){event.preventDefault();setSaving(true);try{if(form.mode==='distribute'){await post('payments/register',{...form,amount:Number(form.amount)});}else{if(!form.installment_id)throw new Error('Elegí el pago a registrar.');await post(`payments/${form.installment_id}/register`,{...form,amount:Number(form.amount)});}notify('Cobro registrado correctamente.');onClose();onSaved();}catch(error){notify(error.message);}finally{setSaving(false);}}
  const footer=<><button className="button secondary" type="button" onClick={onClose}>Cancelar</button><button className="button primary" form="payment-form" disabled={saving||!form.contract_id||(!form.amount&&form.mode==='distribute')}>{saving?'Guardando…':'Guardar'}</button></>;
  if(!installment)return null;
  return <Modal open title="Nuevo cobro" subtitle="Registre el cobro de un alquiler o llave" onClose={onClose} footer={footer}>
    <form id="payment-form" className="payment-form" onSubmit={submit}>
      <section className="segmented full"><span>Tipo de pago</span><div><label><input type="radio" name="payment_type" value="Alquiler" checked={form.payment_type==='Alquiler'} onChange={change}/> 🏠 Alquiler</label><label><input type="radio" name="payment_type" value="Llave" checked={form.payment_type==='Llave'} onChange={change}/> 🔑 Llave</label></div><small>Pago mensual de alquiler o cobros extraordinarios de llave.</small></section>
      <label className="field"><span>Fecha de pago *</span><input name="paid_at" type="date" value={form.paid_at} onChange={change} required/></label>
      <section className="segmented full"><span>Modo de registro</span><div><label><input type="radio" name="mode" value="specific" checked={form.mode==='specific'} onChange={change}/> 🧾 Pago específico</label><label><input type="radio" name="mode" value="distribute" checked={form.mode==='distribute'} onChange={change}/> 💰 Distribuir monto</label></div><small>{form.mode==='distribute'?'Ingresa un monto total y se distribuye automáticamente entre los pagos pendientes.':'Elegí una cuota pendiente concreta.'}</small></section>
      <label className="field full"><span>Contrato *</span><select name="contract_id" value={form.contract_id} onChange={change} required><option value="">Seleccionar contrato</option>{contracts.map(contract=><option key={contract.id} value={contract.id}>{contract.label}</option>)}</select></label>
      {form.mode==='specific'&&<label className="field full"><span>Pago a registrar *</span><select name="installment_id" value={form.installment_id} onChange={change} required><option value="">Seleccionar pago pendiente</option>{installments.map(item=><option key={item.id} value={item.id}>{item.period} — {money(item.due_amount,item.currency)} · {item.status}</option>)}</select></label>}
      {selected&&<section className="payment-summary full"><header><div><strong>Resumen del pago</strong><span>{selected.period}</span></div><StatusTag text={selected.status}/></header><div><span>Alquiler</span><b>{money(selected.expected_amount,selected.currency)}</b></div>{Number(selected.vat_amount)>0&&<div><span>IVA</span><b>{money(selected.vat_amount,selected.currency)}</b></div>}{Number(selected.late_fee_amount)>0&&<div><span>Punitorios</span><b>{money(selected.late_fee_amount,selected.currency)}</b></div>}{Number(selected.discount_amount)>0&&<div><span>Descuento</span><b>- {money(selected.discount_amount,selected.currency)}</b></div>}<div><span>Saldo a cobrar</span><b>{money(selected.due_amount,selected.currency)}</b></div><p>¿Necesitás corregir un concepto? Podés editar alquiler, IVA, punitorios y descuentos en <a href="#pending-collections">cobros pendientes →</a></p></section>}
      <section className="radio-line full"><span>Monto a registrar</span><label><input type="radio" name="amount_mode" value="full" checked={form.amount_mode==='full'} onChange={change}/> Pago completo</label><label><input type="radio" name="amount_mode" value="partial" checked={form.amount_mode==='partial'} onChange={change}/> Pago parcial</label></section>
      {(form.amount_mode==='partial'||form.mode==='distribute')&&<label className="field full"><span>Importe *</span><input name="amount" type="number" min="0" step="0.01" value={form.amount} onChange={change} required/></label>}
      <label className="checkbox-line full"><input type="checkbox" name="is_split" value="true" onChange={change}/><span>💳 Pago dividido</span></label>
      <label className="field full"><span>Método de pago *</span><select name="method" value={form.method} onChange={change} required><option>Transferencia</option><option>Efectivo</option><option>Depósito</option><option>Cheque</option><option>Otro</option></select></label>
      <label className="field full"><span>Cuenta donde se recibió el pago (opcional)</span><input name="account_name" value={form.account_name} onChange={change} placeholder={form.method==='Efectivo'?'Efectivo (creá una cuenta si querés especificar)':'Banco / cuenta'} /></label>
      <section className="radio-line full"><span>Estado tributario *</span><label><input type="radio" name="tax_status" value="Declarado" checked={form.tax_status==='Declarado'} onChange={change}/> ✅ Declarado</label><label><input type="radio" name="tax_status" value="No declarado aún" checked={form.tax_status==='No declarado aún'} onChange={change}/> ⚫ No declarado aún</label></section>
      <label className="field full"><span>Notas internas (opcional)</span><textarea name="notes" value={form.notes} onChange={change} placeholder="Notas internas sobre este pago..." /><small>Solo las ves vos; no se muestran al inquilino.</small></label>
    </form>
  </Modal>;
}

function StatusTag({text}){return <span className="status-tag">{text}</span>}
