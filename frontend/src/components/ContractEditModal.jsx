import {useEffect,useState} from 'react';
import {api,patch} from '../api/client';
import {FormField} from './FormField';
import {Modal} from './Modal';
import {ContractConditions} from './ContractConditions';
export function ContractEditModal({contract,onClose,actions}){
  const [alias,setAlias]=useState(''),[note,setNote]=useState(''),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!contract)return;let active=true;setAlias(contract.alias||'');setNote('');setError('');setLoading(true);
    api(`contracts/${contract.id}/protection`).then(data=>{if(active)setNote(data.administrative_note);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
  },[contract]);
  if(!contract)return null;
  async function submit(event){event.preventDefault();setSaving(true);try{await patch(`contracts/${contract.id}`,{alias,administrative_note:note});actions.notify('Datos administrativos guardados. Las condiciones del contrato se conservaron.');actions.reload({silent:true});onClose();}catch(e){actions.notify(e.message);}finally{setSaving(false);}}
  return <Modal open title="Editar contrato" subtitle={`${contract.code} · Información administrativa`} onClose={onClose} footer={<><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" form="contract-admin-form" disabled={saving||loading||Boolean(error)}>Guardar datos administrativos</button></>}>
    <form id="contract-admin-form" className="contract-edit-form" onSubmit={submit}>
      <FormField label="Alias interno" name="alias" value={alias} onChange={event=>setAlias(event.target.value)}/>
      <FormField label="Nota administrativa" name="administrative_note" as="textarea" full disabled={loading||Boolean(error)} value={note} onChange={event=>setNote(event.target.value)} help="Anotación interna. No reemplaza cláusulas ni modifica importes, vencimientos o pagos."/>
      {error&&<p role="alert">No pudimos cargar la nota administrativa: {error}. Cerrá y volvé a intentar para conservar los datos anteriores.</p>}
    </form>
    <ContractConditions contract={contract}/>
    {contract.source_document_id?<a className="button secondary" href={`/api/document-admin/file?document_id=${contract.source_document_id}`} target="_blank" rel="noreferrer">Consultar PDF original</a>:<p>No hay PDF original asociado. Sin evidencia suficiente, la rectificación queda bloqueada.</p>}
    <p>Para corregir una lectura errónea usá «Rectificar datos del contrato» desde Ver acciones. Las adendas no se tramitan como rectificaciones.</p>
  </Modal>;
}
