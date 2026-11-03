import {ReimportConfirmation} from '../components/ReimportConfirmation';
import {useMemo,useState} from 'react';
import {post} from '../api/client';
import {DataTable} from '../components/DataTable';
import {Modal} from '../components/Modal';
import {PageHeader} from '../components/PageHeader';
import {StatusPill} from '../components/StatusPill';
import {useApi} from '../hooks/useApi';
import {shortDate} from '../utils/format';

const FILTERS=[['all','Todos'],['pending','Pendientes'],['review','En revisión'],['imported','Importados'],['duplicate','Omitidos por duplicado'],['discarded','Descartados'],['failed','Fallidos'],['contract_deleted','Contrato eliminado'],['excluded','Excluidos']];
const REPROCESS_LABELS={failed:'Reintentar importación',pending:'Importar ahora'};
const fileUrl=ref=>`/api/document-admin/file?${new URLSearchParams(Object.entries(ref).filter(([,value])=>value)).toString()}`;

function HistoryModal({entry,onClose}){if(!entry)return null;return <Modal open title="Historial del documento" subtitle={entry.filename} onClose={onClose}><div className="contract-info-grid"><span>Estado</span><b>{entry.state_label}</b><span>Motivo</span><b>{entry.reason}</b><span>Archivo</span><b>{entry.file_exists?entry.absolute_path:'Ya no está en la carpeta de contratos'}</b>{entry.file_problem&&entry.file_exists&&<><span>Seguridad</span><b>{entry.file_problem}</b></>}<span>Huella (SHA-256)</span><b><code>{entry.sha256||'—'}</code></b></div>{entry.history.length?<ul className="document-history">{entry.history.map(item=><li key={item.id}><strong>{item.label} · {shortDate(item.created_at)}</strong>{item.detail&&<small>{item.detail}</small>}{item.previous_import_id&&<small>Reintento de una lectura anterior.</small>}</li>)}</ul>:<p className="muted">Este archivo todavía no tiene lecturas registradas.</p>}</Modal>}

export function DocumentAdminPage({notify}){
  const{data,error,loading,reload}=useApi('document-admin');
  const[filter,setFilter]=useState('all'),[history,setHistory]=useState(null),[confirmation,setConfirmation]=useState(null),[busy,setBusy]=useState('');
  const rows=useMemo(()=>(data?.entries||[]).filter(entry=>filter==='all'||entry.state===filter),[data,filter]);
  if(loading)return <div className="loading">Cargando documentos…</div>;
  if(error)throw error;
  async function run(entry,operation,body,message){setBusy(entry.id);try{const result=await post(`document-admin/${operation}`,{ref:entry.ref,...body});notify(message(result));reload({silent:true});}catch(err){notify(err.message);}finally{setBusy('');}}
  function reprocess(entry){if(entry.state==='contract_deleted'){setConfirmation(entry);return;}if(!confirm(`¿Volver a leer «${entry.filename}»?\n\nSe crea una nueva importación para revisar. Las lecturas anteriores quedan en el historial.`))return;run(entry,'reprocess',{},result=>result.status==='Revisión'?`«${entry.filename}» quedó listo para revisar en Importaciones.`:`«${entry.filename}»: ${result.error||result.status}.`);}
  function exclude(entry){const reason=prompt(`¿Por qué no querés que «${entry.filename}» se importe automáticamente?`,'No corresponde importarlo');if(reason===null)return;run(entry,'exclude',{reason},()=>`«${entry.filename}» no se va a importar automáticamente.`);}
  function unexclude(entry){run(entry,'unexclude',{},()=>`«${entry.filename}» vuelve a estar disponible para importar.`);}
  function removeRecord(entry){if(!confirm(`¿Quitar «${entry.filename}» de la lista?\n\nSe borran sus lecturas registradas. El PDF no se borra del equipo${entry.file_exists?' y queda excluido para que no se vuelva a importar solo':''}.\n\nEsta acción no se puede deshacer.`))return;run(entry,'delete-record',{confirm:true},result=>`«${entry.filename}» se quitó de la lista${result.excluded?' y quedó excluido de importaciones automáticas':''}.`);}
  function removeFile(entry){if(!confirm(`¿Eliminar «${entry.filename}» del equipo?\n\nEl archivo PDF se borra de la carpeta de contratos y no se puede recuperar desde el sistema. Los registros quedan en el historial.`))return;if(!confirm('Confirmá otra vez: el PDF se borra definitivamente del equipo.'))return;run(entry,'delete-file',{confirm:true,reason:'Eliminado desde Documentos'},()=>`«${entry.filename}» se eliminó del equipo.`);}
  const columns=[
    {key:'file',label:'Documento',render:entry=><><strong>{entry.filename}</strong>{!entry.file_exists&&<small className="document-reason warning">El PDF ya no está en la carpeta de contratos.</small>}{entry.file_exists&&entry.file_problem&&<small className="document-reason warning">{entry.file_problem}</small>}</>},
    {key:'state',label:'Estado',render:entry=><><StatusPill>{entry.state_label}</StatusPill><small className="document-reason">{entry.reason}</small></>},
    {key:'contract',label:'Contrato',render:entry=>entry.contract?<><strong>{entry.contract.alias||entry.contract.code}</strong><small className="document-reason">{entry.contract.status}</small></>:<span className="muted">—</span>},
    {key:'date',label:'Última actividad',render:entry=>entry.date?shortDate(entry.date):'—'},
    {key:'action',label:'',render:entry=>{const has=action=>entry.actions.includes(action),disabled=busy===entry.id;return <div className="action-stack">
      {has('view')&&<a className="button small secondary" href={fileUrl(entry.ref)} target="_blank" rel="noopener noreferrer">Ver PDF</a>}
      {has('open_contract')&&<a className="button small secondary" href={`#contracts?contract=${entry.contract.id}`}>Abrir contrato</a>}
      {has('review')&&<a className="button small primary" href="#imports">Revisar</a>}
      {has('reprocess')&&<button className="button small primary" type="button" disabled={disabled} onClick={()=>reprocess(entry)}>{REPROCESS_LABELS[entry.state]||'Volver a importar'}</button>}
      {has('exclude')&&<button className="button small secondary" type="button" disabled={disabled} onClick={()=>exclude(entry)}>Excluir de importaciones</button>}
      {has('unexclude')&&<button className="button small secondary" type="button" disabled={disabled} onClick={()=>unexclude(entry)}>Quitar exclusión</button>}
      {has('delete_record')&&<button className="button small secondary" type="button" disabled={disabled} onClick={()=>removeRecord(entry)}>Quitar de la lista</button>}
      {has('delete_file')?<button className="button small danger" type="button" disabled={disabled} onClick={()=>removeFile(entry)}>Eliminar PDF del equipo</button>:entry.blocked.delete_file&&entry.file_exists&&<button className="button small danger" type="button" disabled title={entry.blocked.delete_file} aria-label={`Eliminar PDF del equipo: no disponible. ${entry.blocked.delete_file}`}>Eliminar PDF del equipo</button>}
      <button className="button small secondary" type="button" onClick={()=>setHistory(entry)}>Historial</button>
    </div>;}}
  ];
  const counts=data.counts||{},total=data.entries.length;
  return <>
    <PageHeader title="Documentos e importaciones" description="Cada PDF de la carpeta de contratos, qué pasó con él y qué podés hacer."><button className="button secondary" type="button" onClick={()=>reload()}>Actualizar</button><a className="button primary" href="#imports">Ir a Importaciones</a></PageHeader>
    {!data.managed&&<div className="notice danger" role="alert"><b aria-hidden="true">!</b><div><strong>No encontramos la carpeta de contratos</strong><span>Revisá la ruta en Configuración: {data.directory}</span></div></div>}
    <div className="document-admin-filters" role="group" aria-label="Filtrar por estado">{FILTERS.map(([key,label])=>{const value=key==='all'?total:counts[key]||0;if(key!=='all'&&!value&&filter!==key)return null;return <button key={key} type="button" className={`filter-chip ${filter===key?'active':''}`.trim()} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label} ({value})</button>;})}</div>
    <DataTable columns={columns} rows={rows} className="document-admin-table" empty={filter==='all'?'Todavía no hay documentos en la carpeta de contratos':'No hay documentos en este estado'}/>
    <ReimportConfirmation document={confirmation} busy={Boolean(busy)} onClose={()=>{if(!busy)setConfirmation(null);}} onConfirm={()=>run(confirmation,'reprocess',{confirm:true},result=>{setConfirmation(null);return result.status==='Revisión'?'Documento listo para revisar en Importaciones.':result.error||result.status;})}/>
    <HistoryModal entry={history} onClose={()=>setHistory(null)}/>
  </>;
}
