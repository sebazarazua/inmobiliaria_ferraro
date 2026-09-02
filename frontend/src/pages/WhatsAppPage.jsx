import {useEffect,useMemo,useState} from 'react';
import {api,patch,post} from '../api/client';
import {StatusPill} from '../components/StatusPill';
import {shortDate} from '../utils/format';

function Stat({label,value}){return <article className="wa-stat"><small>{label}</small><strong>{value}</strong></article>}

export function WhatsAppPage({notify}){
  const[tab,setTab]=useState('dashboard');
  const[dashboard,setDashboard]=useState(null);
  const[conversations,setConversations]=useState([]);
  const[selected,setSelected]=useState(null);
  const[messages,setMessages]=useState([]);
  const[templates,setTemplates]=useState([]);
  const[automations,setAutomations]=useState([]);
  const[config,setConfig]=useState(null);
  const[reply,setReply]=useState('');
  const[loading,setLoading]=useState(false);

  async function load(){
    setLoading(true);
    try{
      const [dash,conv,tpl,auto,cfg]=await Promise.all([
        api('whatsapp/dashboard'),
        api('whatsapp/conversations'),
        api('whatsapp/templates'),
        api('whatsapp/automations'),
        api('whatsapp/config')
      ]);
      setDashboard(dash);
      setConversations(conv);
      setTemplates(tpl);
      setAutomations(auto);
      setConfig(cfg);
      if(selected)loadMessages(selected.id);
    }catch(error){notify(error.message);}
    finally{setLoading(false);}
  }
  async function loadMessages(id){
    try{setMessages(await api(`whatsapp/conversations/${id}/messages`));}
    catch(error){notify(error.message);}
  }
  useEffect(()=>{load();},[]);
  async function openConversation(conversation){setSelected(conversation);setTab('conversations');await loadMessages(conversation.id);}
  async function sendReply(event){
    event.preventDefault();
    if(!selected||!reply.trim())return;
    try{
      await post(`whatsapp/conversations/${selected.id}/reply`,{text:reply});
      setReply('');
      await loadMessages(selected.id);
      await load();
      notify('Respuesta enviada.');
    }catch(error){notify(error.message);}
  }
  async function setConversationState(action){
    if(!selected)return;
    try{
      const result=await post(`whatsapp/conversations/${selected.id}/${action}`,{});
      const next={...selected,status:result.status};
      setSelected(next);
      setConversations(current=>current.map(item=>item.id===next.id?next:item));
      notify('Conversación actualizada.');
    }catch(error){notify(error.message);}
  }
  async function toggleAutomation(item){
    try{
      await patch(`whatsapp/automations/${item.id}`,{enabled:!item.enabled});
      setAutomations(current=>current.map(row=>row.id===item.id?{...row,enabled:!row.enabled}:row));
    }catch(error){notify(error.message);}
  }
  async function toggleTemplate(item){
    try{
      await patch(`whatsapp/templates/${item.name}`,{enabled:!item.enabled});
      setTemplates(current=>current.map(row=>row.name===item.name?{...row,enabled:!row.enabled}:row));
    }catch(error){notify(error.message);}
  }
  async function processJobs(){
    try{
      const result=await post('whatsapp/jobs/process',{});
      notify(`Jobs procesados: ${result.processed.length}`);
      await load();
    }catch(error){notify(error.message);}
  }
  const stats=dashboard?.stats||{};
  const recent=dashboard?.recent||[];
  const sortedConversations=useMemo(()=>conversations.slice().sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))),[conversations]);

  return <div className="whatsapp-page">
    <header className="wa-hero card">
      <div>
        <p className="eyebrow">WHATSAPP BUSINESS</p>
        <h2>Centro de comunicación</h2>
        <p>Bot de propietarios, conversaciones manuales, templates oficiales y automatizaciones conectadas a eventos reales del sistema.</p>
      </div>
      <div className={`wa-config-pill ${config?.configured?'ok':'warn'}`}>{config?.configured?'Integración configurada':'Faltan credenciales Meta'}</div>
    </header>

    <nav className="wa-tabs">
      {['dashboard','conversations','templates','automations','config'].map(item=><button key={item} className={tab===item?'active':''} onClick={()=>setTab(item)}>{({dashboard:'Dashboard',conversations:'Conversaciones',templates:'Templates',automations:'Automatizaciones',config:'Configuración'})[item]}</button>)}
      <button className="button secondary small" disabled={loading} onClick={load}>{loading?'Actualizando…':'Actualizar'}</button>
    </nav>

    {tab==='dashboard'&&<section className="wa-dashboard">
      <div className="wa-stats-grid">
        <Stat label="Conversaciones activas" value={stats.active_conversations||0}/>
        <Stat label="Mensajes enviados" value={stats.sent_total||0}/>
        <Stat label="Entregados" value={stats.delivered||0}/>
        <Stat label="Leídos" value={stats.read||0}/>
        <Stat label="Errores" value={stats.errors||0}/>
        <Stat label="Automatizaciones recientes" value={stats.recent_automations||0}/>
      </div>
      <section className="card wa-card">
        <h3>Actividad reciente</h3>
        {recent.length?recent.map(item=><button className="wa-recent-row" key={item.id} onClick={()=>openConversation(item)}>
          <span><strong>{item.owner||item.phone_e164}</strong><small>{item.last_message||'Sin mensajes'}</small></span>
          <StatusPill>{item.status}</StatusPill>
        </button>):<p className="muted">Todavía no hay conversaciones.</p>}
      </section>
    </section>}

    {tab==='conversations'&&<section className="wa-conversations card">
      <aside>
        <h3>Conversaciones</h3>
        {sortedConversations.map(item=><button key={item.id} className={selected?.id===item.id?'active':''} onClick={()=>openConversation(item)}>
          <strong>{item.owner||item.phone_e164}</strong>
          <small>{item.status} · {item.last_message||'Sin mensajes'}</small>
        </button>)}
        {!sortedConversations.length&&<span className="muted">No hay conversaciones registradas.</span>}
      </aside>
      <main>
        {selected?<>
          <header className="wa-chat-head">
            <div><h3>{selected.owner||selected.phone_e164}</h3><p>{selected.phone_e164} · <StatusPill>{selected.status}</StatusPill></p></div>
            <div className="wa-chat-actions">
              <button className="button secondary small" onClick={()=>setConversationState('take')}>Tomar</button>
              <button className="button secondary small" onClick={()=>setConversationState('bot')}>Devolver al bot</button>
              <button className="button secondary small" onClick={()=>setConversationState('close')}>Cerrar</button>
            </div>
          </header>
          <div className="wa-chat-log">
            {messages.map(message=><article key={message.id} className={`wa-message ${message.direction==='INBOUND'?'in':'out'}`}>
              <small>{message.direction} · {message.status||'—'} · {shortDate(message.created_at)}</small>
              <p>{message.body||message.error||message.message_type}</p>
            </article>)}
          </div>
          <form className="wa-reply" onSubmit={sendReply}>
            <textarea value={reply} onChange={event=>setReply(event.target.value)} placeholder="Responder manualmente..." />
            <button className="button primary">Enviar</button>
          </form>
        </>:<div className="empty"><strong>Seleccioná una conversación</strong><span>Desde acá podés ver historial, tomarla o responder manualmente.</span></div>}
      </main>
    </section>}

    {tab==='templates'&&<section className="card wa-card">
      <h3>Templates oficiales</h3>
      <table><thead><tr><th>Nombre interno</th><th>Template Meta</th><th>Categoría</th><th>Idioma</th><th>Estado</th><th>Activo</th></tr></thead><tbody>
        {templates.map(item=><tr key={item.name}><td><strong>{item.name}</strong><small>{item.description}</small></td><td>{item.meta_template_name}</td><td>{item.category}</td><td>{item.language}</td><td><StatusPill>{item.status}</StatusPill></td><td><button className="button small secondary" onClick={()=>toggleTemplate(item)}>{item.enabled?'Desactivar':'Activar'}</button></td></tr>)}
      </tbody></table>
    </section>}

    {tab==='automations'&&<section className="card wa-card">
      <div className="wa-card-head"><h3>Automatizaciones</h3><button className="button secondary small" onClick={processJobs}>Procesar cola ahora</button></div>
      <table><thead><tr><th>Evento</th><th>Trigger</th><th>Template</th><th>Preferencia</th><th>Estado</th></tr></thead><tbody>
        {automations.map(item=><tr key={item.id}><td><strong>{item.event_type}</strong></td><td>{item.trigger_description}</td><td>{item.template_name}<small>{item.template_status}</small></td><td>{item.preference_key||'—'}</td><td><button className="button small secondary" onClick={()=>toggleAutomation(item)}>{item.enabled?'Activa':'Pausada'}</button></td></tr>)}
      </tbody></table>
    </section>}

    {tab==='config'&&<section className="card wa-card">
      <h3>Configuración de integración</h3>
      <div className="wa-config-grid">
        <span>Estado</span><b>{config?.configured?'Configurada':'Incompleta'}</b>
        <span>Phone Number ID</span><b>{config?.phone_number_id||'No cargado'}</b>
        <span>Business Account ID</span><b>{config?.business_account_id||'No cargado'}</b>
        <span>Webhook</span><b>{config?.webhook_path}</b>
        <span>Graph API</span><b>{config?.graph_version}</b>
        <span>Verify token</span><b>{config?.verify_token_set?'Configurado':'No configurado'}</b>
        <span>App Secret</span><b>{config?.app_secret_set?'Configurado':'No configurado'}</b>
      </div>
      <p className="muted">Los access tokens nunca se muestran en el frontend.</p>
    </section>}
  </div>;
}
