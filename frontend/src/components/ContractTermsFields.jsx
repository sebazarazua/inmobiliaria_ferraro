import {useState} from 'react';
import {FormField} from './FormField';
import {UPDATE_OPTIONS,FREQUENCY_OPTIONS,LATE_FEE_OPTIONS,updateMethod,selectUpdateMethod} from '../utils/contract-options.mjs';

export function AdjustmentFields({form,onChange}){
  const method=updateMethod(form),frequency=String(form.adjustment_frequency_months??'');
  const [customFrequency,setCustomFrequency]=useState(false);
  const other=customFrequency||(frequency!==''&&!FREQUENCY_OPTIONS.some(([value])=>value===frequency));
  const optionalFrequency=['MANUAL','CUSTOM_INDEX'].includes(method);
  const previousLag=Number(form.ipc_lag_months)===0?'0':'1';
  return <>
    <FormField full label="¿Cómo se actualiza el alquiler?" name="rent_update_method" as="select" required value={method} options={[[ '', 'Elegí el mecanismo del contrato' ],...UPDATE_OPTIONS]} onChange={event=>onChange(selectUpdateMethod(event.target.value))}/>
    {!method&&<p className="full field-help" role="status">Revisá la cláusula original y elegí cómo se actualiza el alquiler. No se reemplazan condiciones anteriores automáticamente.</p>}
    <FormField label="¿Cada cuánto aumenta el alquiler?" name="rent_update_frequency" as="select" value={other?'other':frequency} options={[[ '', optionalFrequency?'Sin frecuencia definida en el contrato':'Elegí la frecuencia' ],...FREQUENCY_OPTIONS]} required={!optionalFrequency} onChange={event=>{setCustomFrequency(event.target.value==='other');onChange({adjustment_frequency_months:event.target.value==='other'?'':event.target.value});}}/>
    {other&&<FormField label="Cantidad de meses entre aumentos" name="adjustment_frequency_months" type="number" min="1" step="1" required value={frequency} onChange={event=>onChange({adjustment_frequency_months:event.target.value})}/>}
    {method==='FIXED_PERCENTAGE'&&<FormField label="Porcentaje de aumento (%)" name="adjustment_value_pct" type="number" min="0" step="0.001" required value={form.adjustment_value_pct??''} onChange={event=>onChange({adjustment_value_pct:event.target.value})}/>}
    {method==='IPC'&&<FormField label="¿Qué mes del IPC se utiliza para calcular el aumento?" name="ipc_lag_months" as="select" value={String(form.ipc_lag_months??0)} options={[[previousLag,'Mes anterior al ajuste'],['2','Dos meses anteriores'],...(Number(form.ipc_lag_months)>2?[[String(form.ipc_lag_months),`${form.ipc_lag_months} meses anteriores (condición existente)`]]:[])]} onChange={event=>onChange({ipc_lag_months:event.target.value})}/>}
    {method==='CUSTOM_INDEX'&&<FormField label="Nombre del índice o mecanismo" name="adjustment_index" value={form.adjustment_index??''} onChange={event=>onChange({adjustment_index:event.target.value})}/>}
    {['MANUAL','CUSTOM_INDEX'].includes(method)&&<FormField label="Condiciones de actualización" name="notes" as="textarea" full value={form.notes??''} onChange={event=>onChange({notes:event.target.value})} help="Conservá lo acordado en el contrato, incluidos los criterios para revisar el importe."/>}
    {method&&method!=='IPC'&&<p className="full field-help" role="status">Este mecanismo requiere intervención manual. El sistema no calcula sus aumentos automáticamente ni utiliza IPC para reemplazarlo.</p>}
  </>;
}

export function LateFeeFields({form,onChange}){
  return <>
    <FormField full label="¿Cómo se calculan los intereses por demora?" name="late_fee_type" as="select" value={form.late_fee_type||'NONE'} options={LATE_FEE_OPTIONS} onChange={event=>onChange({late_fee_type:event.target.value})}/>
    {form.late_fee_type==='FIXED_DAILY'&&<FormField label="Interés diario (%)" name="late_fee_daily_pct" type="number" min="0" step="0.01" value={form.late_fee_daily_pct??''} onChange={event=>onChange({late_fee_daily_pct:event.target.value})}/>}
    {form.late_fee_type==='BANK_ACTIVE_RATE'&&<p className="full field-help">Se conserva la condición del contrato. El cálculo de la tasa activa del Banco Nación todavía no está implementado.</p>}
  </>;
}

export function PaymentScheduleFields({form,onChange,periodFields=false}){
  const [expanded,setExpanded]=useState(false);
  const hasPeriod=form.payment_period_start_day!==''&&form.payment_period_start_day!=null||form.payment_period_end_day!==''&&form.payment_period_end_day!=null;
  return <>
    <FormField label="Día de vencimiento del alquiler" name="payment_due_day" type="number" min="1" max="31" required value={form.payment_due_day??10} onChange={event=>onChange({payment_due_day:event.target.value})} help="Día registrado como vencimiento de la cuota. No cambia al editar el período de pago."/>
    {periodFields&&(hasPeriod||expanded)?<>
      <FormField label="Primer día del período de pago" name="payment_period_start_day" type="number" min="1" max="31" value={form.payment_period_start_day??''} onChange={event=>onChange({payment_period_start_day:event.target.value})}/>
      <FormField label="Último día del período de pago" name="payment_period_end_day" type="number" min="1" max="31" value={form.payment_period_end_day??''} onChange={event=>onChange({payment_period_end_day:event.target.value})}/>
      <p className="full field-help">El período indica cuándo puede pagarse según el contrato. El vencimiento se conserva por separado; ninguno de estos días se deduce automáticamente.</p>
    </>:periodFields&&<button type="button" className="button secondary" onClick={()=>setExpanded(true)}>Indicar período de pago del contrato</button>}
  </>;
}
