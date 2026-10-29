import {useState} from 'react';
import {Icon} from './Icon';

const nav=[
  {id:'dashboard',icon:'dashboard',label:'Resumen'},
  {id:'contracts',icon:'contract',label:'Contratos'},
  {id:'propertyGroup',icon:'building',label:'Propiedades',children:[
    {id:'properties',icon:'home',label:'Propiedades'},
    {id:'owners',icon:'user',label:'Propietarios'}
  ]},
  {id:'tenantGroup',icon:'users',label:'Inquilinos',children:[
    {id:'tenants',icon:'user',label:'Inquilinos'},
    {id:'guarantors',icon:'shield',label:'Garantes'}
  ]},
  {id:'financeGroup',icon:'wallet',label:'Cobros y gastos',children:[
    {id:'collections',icon:'receipt',label:'Cobros'},
    {id:'pending-collections',icon:'clock',label:'Cobros pendientes'},
    {id:'expenses',icon:'expense',label:'Gastos'},
    {id:'services',icon:'service',label:'Servicios'},
    {id:'other-income',icon:'income',label:'Otros ingresos'}
  ]},
  {id:'whatsapp',icon:'message',label:'WhatsApp'},
  {id:'incidents',icon:'alert',label:'Incidencias'},
  {id:'documents',icon:'folder',label:'Documentos'},
  {id:'imports',icon:'import',label:'Importaciones'},
  {id:'settings',icon:'settings',label:'Configuración'}
];

export const routeTitles=Object.fromEntries(nav.flatMap(item=>item.children?item.children.map(child=>[child.id,child.label]):[[item.id,item.label]]));

export function Layout({route,reviews=0,onScan,scanning,children}){
  const[menu,setMenu]=useState(false);
  const group=nav.find(item=>item.children?.some(child=>child.id===route));
  return <div className="shell">
    <aside id="sidebar" className={`sidebar ${menu?'open':''}`}>
      <a className="brand" href="#dashboard" onClick={()=>setMenu(false)}><b aria-hidden="true">F</b><span>Ferraro<small>Propiedades</small></span></a>
      <p className="nav-label">Operación</p>
      <nav aria-label="Secciones">{nav.map(item=>item.children?<div key={item.id} className={`nav-group ${item.children.some(child=>child.id===route)?'active':''}`.trim()}><a className="nav-group-label" href={`#${item.children[0].id}`} title={item.label} onClick={()=>setMenu(false)}><i><Icon name={item.icon}/></i><span>{item.label}</span><b><Icon name="chevron" size={14}/></b></a>{item.children.map(child=><a key={child.id} className={`${route===child.id?'active':''} nav-child`.trim()} href={`#${child.id}`} title={child.label} onClick={()=>setMenu(false)}><i><Icon name={child.icon}/></i><span>{child.label}</span></a>)}</div>:<a key={item.id} className={route===item.id?'active':''} href={`#${item.id}`} title={item.label} onClick={()=>setMenu(false)}><i><Icon name={item.icon}/></i><span>{item.label}</span>{item.id==='imports'&&reviews>0?<em title="Contratos para revisar">{reviews}</em>:null}</a>)}</nav>
      <div className="family"><b aria-hidden="true">EF</b><div><strong>Eugenio A. Ferraro</strong><small>Administración</small></div></div>
    </aside>
    <main>
      <header className="topbar">
        <button className="icon-button mobile" onClick={()=>setMenu(!menu)} aria-label="Abrir menú" aria-expanded={menu} aria-controls="sidebar"><Icon name="menu" size={18}/></button>
        <div className="topbar-title"><p className="breadcrumb"><span>Ferraro Propiedades</span>{group&&group.label!==routeTitles[route]&&<><span aria-hidden="true">/</span><span>{group.label}</span></>}</p><h1>{routeTitles[route]}</h1></div>
        <div className="top-actions"><span className="sync"><i aria-hidden="true"/>PostgreSQL conectado</span><button className="button secondary" disabled={scanning} onClick={onScan}>{scanning?'Escaneando…':'Escanear contratos'}</button></div>
      </header>
      <section className="content">{children}</section>
    </main>
  </div>;
}
