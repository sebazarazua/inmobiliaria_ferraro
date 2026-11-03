import {useEffect,useState} from 'react';
import {api,post} from '../api/client';
import {Modal} from './Modal';

const ALTERNATIVE_LABELS={void:'Anular contrato',archive:'Archivar',deactivate:'Desactivar temporalmente'};
const MANAGE_LABELS={properties:'Ir a Propiedades',owners:'Ir a Propietarios',tenants:'Ir a Inquilinos'};

function ImpactSection({title,items,tone,render}){if(!items?.length)return null;return <section className={`impact-section ${tone||''}`.trim()}><h3>{title}</h3><ul>{items.map((item,index)=><li key={item.id||`${item.label}-${index}`}>{render(item)}</li>)}</ul></section>}

// Vista previa obligatoria antes de eliminar: el backend calcula el impacto y vuelve a validarlo al borrar.
export function ImpactModal({target,onClose,onDone,notify}){
  const[state,setState]=useState({loading:true,data:null,error:null}),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!target)return;let active=true;setConfirmed(false);setState({loading:true,data:null,error:null});api(`${target.resource}/${target.id}/impact`).then(data=>{if(active)setState({loading:false,data,error:null});}).catch(error=>{if(active)setState({loading:false,data:null,error});});return()=>{active=false;};},[target]);
  if(!target)return null;
  const data=state.data,alternatives=data?(data.entity.type==='contract'?data.alternatives||[]:(!data.entity.archived_at&&!data.archive_blocker?['archive']:[])):[];
  async function remove(){setBusy(true);try{await api(`${target.resource}/${target.id}`,{method:'DELETE',body:JSON.stringify({confirm:true,reason:'Eliminado desde la vista previa'})});notify(`«${data.entity.label}» se eliminó. Lo vinculado quedó conservado.`);onDone?.();onClose();}catch(error){notify(error.message);}finally{setBusy(false);}}
  async function alternative(action){
    let reason='';
    if(action==='void'){const value=prompt(`Motivo para anular ${data.entity.label}:`,'Cargado por error');if(value===null)return;reason=value;}
    setBusy(true);try{const result=await post(`${target.resource}/${target.id}/${action}`,{reason:reason||`${ALTERNATIVE_LABELS[action]} desde la vista previa`});notify([`«${data.entity.label}»: ${ALTERNATIVE_LABELS[action].toLowerCase()} listo.`,...(result.warnings||[])].join(' '));onDone?.();onClose();}catch(error){notify(error.message);}finally{setBusy(false);}
  }
  const footer=<><button className="button secondary" type="button" onClick={onClose}>Cancelar</button>{alternatives.map(action=><button key={action} className="button secondary" type="button" disabled={busy} onClick={()=>alternative(action)}>{ALTERNATIVE_LABELS[action]}</button>)}{data?.can_delete&&<button className="button danger" type="button" disabled={busy||!confirmed} onClick={remove}>{busy?'Eliminando…':'Eliminar definitivamente'}</button>}</>;
  return <Modal open title={`Eliminar ${target.noun||'registro'}`} subtitle="Revisá qué se borra y qué se conserva antes de confirmar." onClose={onClose} footer={footer}>
    {state.loading?<div className="loading">Calculando qué registros se verían afectados…</div>:state.error?<div className="notice danger" role="alert"><b aria-hidden="true">!</b><div><strong>No pudimos preparar la vista previa</strong><span>{state.error.message}</span></div></div>:<div className="impact-preview">
      <div className="impact-entity"><strong>{data.entity.label}</strong>{data.entity.detail&&<small>{data.entity.detail}</small>}{data.entity.status&&<small>Estado actual: {data.entity.status}</small>}</div>
      {data.blockers.length>0&&<div className="notice danger" role="alert"><b aria-hidden="true">!</b><div><strong>No se puede eliminar</strong><ul>{data.blockers.map(blocker=><li key={blocker}>{blocker}</li>)}</ul>{alternatives.length>0&&<span>Podés usar {alternatives.map(action=>`«${ALTERNATIVE_LABELS[action]}»`).join(' o ')} para conservar el historial.</span>}{data.archive_blocker&&<span>{data.archive_blocker}</span>}</div></div>}
      <ImpactSection title="Se elimina definitivamente" tone="remove" items={data.remove} render={item=><><span>{item.label}</span><b>{item.count}</b></>}/>
      <ImpactSection title="Se desvincula, pero se conserva" items={data.unlink} render={item=><><span>{item.label}</span><b>{item.count}</b></>}/>
      <ImpactSection title="Se conserva y podés administrarlo después" items={data.keep} render={item=><><span><strong>{item.label}</strong><small>{item.role} · {item.detail}</small></span>{item.manage&&<a href={`#${item.manage}`} onClick={onClose}>{MANAGE_LABELS[item.manage]}</a>}</>}/>
      {data.can_delete&&<><div className="notice"><b aria-hidden="true">!</b><div><strong>Acción irreversible</strong>{data.irreversible.map(text=><span key={text}>{text}</span>)}<span>Los cobros, la contabilidad y la auditoría nunca se borran con esta acción.</span></div></div>
      <label className="checkbox-line"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>Revisé la lista y entiendo que esta eliminación no se puede deshacer.</span></label></>}
    </div>}
  </Modal>;
}
