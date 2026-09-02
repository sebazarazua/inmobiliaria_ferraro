import {useState} from 'react';

const nav=[
  {id:'dashboard',icon:'▦',label:'Resumen'},
  {id:'contracts',icon:'▤',label:'Contratos'},
  {id:'propertyGroup',icon:'▥',label:'Propiedades',children:[
    {id:'properties',icon:'⌂',label:'Propiedades'},
    {id:'owners',icon:'▥',label:'Propietarios'}
  ]},
  {id:'tenantGroup',icon:'♧',label:'Inquilinos',children:[
    {id:'tenants',icon:'♧',label:'Inquilinos'},
    {id:'guarantors',icon:'▧',label:'Garantes'}
  ]},
  {id:'financeGroup',icon:'$',label:'Cobros y gastos',children:[
    {id:'collections',icon:'▣',label:'Cobros'},
    {id:'pending-collections',icon:'◷',label:'Cobros pendientes'},
    {id:'expenses',icon:'▤',label:'Gastos'},
    {id:'services',icon:'♨',label:'Servicios'},
    {id:'other-income',icon:'▱',label:'Otros ingresos'}
  ]},
  {id:'whatsapp',icon:'☏',label:'WhatsApp'},
  {id:'incidents',icon:'!',label:'Incidencias'},
  {id:'documents',icon:'□',label:'Documentos'},
  {id:'imports',icon:'↻',label:'Importaciones'},
  {id:'settings',icon:'⚙',label:'Configuración'}
];

export const routeTitles=Object.fromEntries(nav.flatMap(item=>item.children?item.children.map(child=>[child.id,child.label]):[[item.id,item.label]]));

export function Layout({route,reviews=0,onScan,scanning,children}){
  const[menu,setMenu]=useState(false);
  return <div className="shell">
    <aside className={`sidebar ${menu?'open':''}`}>
      <a className="brand" href="#dashboard" onClick={()=>setMenu(false)}><b>F</b><span>Ferraro<small>Propiedades</small></span></a>
      <p className="nav-label">OPERACIÓN</p>
      <nav>{nav.map(item=>item.children?<div key={item.id} className={`nav-group ${item.children.some(child=>child.id===route)?'active':''}`.trim()}><a className="nav-group-label" href={`#${item.children[0].id}`} onClick={()=>setMenu(false)}><i>{item.icon}</i><span>{item.label}</span><b>⌄</b></a>{item.children.map(child=><a key={child.id} className={`${route===child.id?'active':''} nav-child`.trim()} href={`#${child.id}`} onClick={()=>setMenu(false)}><i>{child.icon}</i><span>{child.label}</span></a>)}</div>:<a key={item.id} className={route===item.id?'active':''} href={`#${item.id}`} onClick={()=>setMenu(false)}><i>{item.icon}</i><span>{item.label}</span>{item.id==='imports'&&reviews>0?<em>{reviews}</em>:null}</a>)}</nav>
      <div className="family"><b>EF</b><div><strong>Eugenio A. Ferraro</strong><small>Administración</small></div></div>
    </aside>
    <main>
      <header className="topbar">
        <button className="icon-button mobile" onClick={()=>setMenu(!menu)} aria-label="Abrir menú">☰</button>
        <div><p className="eyebrow">ADMINISTRACIÓN DE ALQUILERES</p><h1>{routeTitles[route]}</h1></div>
        <div className="top-actions"><span className="sync"><i/>PostgreSQL conectado</span><button className="button secondary" disabled={scanning} onClick={onScan}>{scanning?'Escaneando…':'Escanear contratos'}</button></div>
      </header>
      <section className="content">{children}</section>
    </main>
  </div>;
}
