import {useEffect,useMemo,useState} from 'react';
import {api,patch,post} from '../api/client';
import {FormField} from './FormField';
import {Modal} from './Modal';

const vatConditions=[
  ['','Seleccionar...'],
  ['Monotributista','Monotributista'],
  ['Responsable inscripto','Responsable inscripto'],
  ['Exento','Exento'],
  ['Consumidor final','Consumidor final'],
  ['No responsable','No responsable']
];

const emptyOwner={
  person_kind:'PERSON',
  first_name:'',
  last_name:'',
  document_number:'',
  tax_id:'',
  vat_condition:'',
  email:'',
  phone:'',
  whatsapp:'',
  whatsapp_opt_in:true,
  whatsapp_preferences_json:{liquidations:true,payments:true,adjustments:true,expirations:true,documents:true},
  liquidation_email_enabled:false,
  address:'',
  country:'Argentina',
  province:'',
  city:'',
  neighborhood:'',
  fiscal_address:'',
  gross_income_number:'',
  activity_start_date:''
};

function splitName(owner={}){
  if(owner.first_name||owner.last_name)return{first_name:owner.first_name||'',last_name:owner.last_name||''};
  const parts=String(owner.full_name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length<=1)return{first_name:parts[0]||'',last_name:''};
  return{first_name:parts.slice(0,-1).join(' '),last_name:parts.at(-1)};
}

function toForm(owner){
  if(!owner)return emptyOwner;
  const names=splitName(owner);
  const isCaba=owner.province==='CABA';
  return{
    ...emptyOwner,
    ...owner,
    ...names,
    person_kind:owner.person_kind||'PERSON',
    document_number:owner.document_number||'',
    tax_id:owner.tax_id||'',
    vat_condition:owner.vat_condition||'',
    email:owner.email||'',
    phone:owner.phone||'',
    whatsapp:owner.whatsapp||'',
    whatsapp_opt_in:owner.whatsapp_opt_in!==false,
    whatsapp_preferences_json:{liquidations:true,payments:true,adjustments:true,expirations:true,documents:true,...(owner.whatsapp_preferences_json||{})},
    liquidation_email_enabled:Boolean(owner.liquidation_email_enabled),
    address:owner.address||'',
    country:owner.country||'Argentina',
    province:owner.province||'',
    city:isCaba?'':owner.city||'',
    neighborhood:isCaba?owner.neighborhood||'':'',
    fiscal_address:owner.fiscal_address||'',
    gross_income_number:owner.gross_income_number||'',
    activity_start_date:String(owner.activity_start_date||'').slice(0,10)
  };
}

function OwnerPropertySelector({properties,selected,setSelected}){
  const[search,setSearch]=useState('');
  const selectedSet=new Set(selected);
  const selectedRows=properties.filter(item=>selectedSet.has(item.id));
  const matches=properties
    .filter(item=>!selectedSet.has(item.id))
    .filter(item=>JSON.stringify(item).toLowerCase().includes(search.toLowerCase()))
    .slice(0,8);
  const add=id=>setSelected(current=>current.includes(id)?current:[...current,id]);
  const remove=id=>setSelected(current=>current.filter(item=>item!==id));
  return <section className="owner-linked-properties full">
    <h3>Propiedades vinculadas</h3>
    <p>Buscá y agregá las propiedades que pertenecen a este propietario.</p>
    <div className="owner-property-search">
      <span>⌕</span>
      <input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Buscar propiedad por dirección o contrato..." />
    </div>
    {search&&<div className="owner-property-results">
      {matches.length?matches.map(property=><button type="button" key={property.id} onClick={()=>{add(property.id);setSearch('');}}>
        <strong>{property.address}</strong>
        <small>{property.active_contract_alias||property.active_contract_code||property.code||'Sin contrato activo'}</small>
      </button>):<span>No encontramos propiedades con esa búsqueda.</span>}
    </div>}
    {selectedRows.length?<div className="owner-linked-list">
      {selectedRows.map(property=><div key={property.id}>
        <span><strong>{property.address}</strong><small>{property.active_contract_alias||property.active_contract_code||property.code||'Sin contrato activo'}</small></span>
        <button type="button" onClick={()=>remove(property.id)}>Quitar</button>
      </div>)}
    </div>:<span className="owner-empty-link">Todavía no vinculaste ninguna propiedad.</span>}
  </section>;
}

export function OwnerModal({open,owner,onClose,onSaved,notify}){
  const[form,setForm]=useState(emptyOwner);
  const[properties,setProperties]=useState([]);
  const[geoOptions,setGeoOptions]=useState({provinces:[],localities:[]});
  const[selectedProperties,setSelectedProperties]=useState([]);
  const[loadingLocalities,setLoadingLocalities]=useState(false);
  const[saving,setSaving]=useState(false);
  const editing=Boolean(owner?.id);

  useEffect(()=>{
    if(!open)return;
    const next=toForm(owner);
    setForm(next);
    setSelectedProperties(Array.isArray(owner?.property_ids)?owner.property_ids.filter(Boolean):[]);
    Promise.all([api('properties'),api('geo/provinces')])
      .then(([propertyRows,geo])=>{
        setProperties(propertyRows);
        setGeoOptions(current=>({...current,provinces:geo.provinces||[]}));
      })
      .catch(error=>notify(error.message));
    if(next.province)loadLocalities(next.province);
    else setGeoOptions(current=>({...current,localities:[]}));
  },[open,owner,notify]);

  async function loadLocalities(province){
    setLoadingLocalities(true);
    try{
      const payload=await api(`geo/localities?province=${encodeURIComponent(province)}`);
      setGeoOptions(current=>({...current,localities:payload.localities||[]}));
    }catch(error){
      notify(error.message);
    }finally{
      setLoadingLocalities(false);
    }
  }

  function change(event){
    const{name,value,type,checked}=event.target;
    if(name.startsWith('whatsapp_pref_')){
      const key=name.replace('whatsapp_pref_','');
      setForm(current=>({...current,whatsapp_preferences_json:{...current.whatsapp_preferences_json,[key]:checked}}));
      return;
    }
    setForm(current=>({...current,[name]:type==='checkbox'?checked:value}));
  }

  async function changeProvince(event){
    const province=event.target.value;
    setForm(current=>({...current,province,city:'',neighborhood:''}));
    setGeoOptions(current=>({...current,localities:[]}));
    if(province)await loadLocalities(province);
  }

  async function submit(event){
    event.preventDefault();
    setSaving(true);
    try{
      const isCaba=form.province==='CABA';
      const payload={
        ...form,
        full_name:[form.first_name,form.last_name].filter(Boolean).join(' ').trim(),
        document_type:'DNI',
        city:isCaba?'':form.city,
        neighborhood:isCaba?form.neighborhood:'',
        whatsapp_opt_in:form.whatsapp_opt_in,
        whatsapp_preferences_json:form.whatsapp_preferences_json,
        property_ids:selectedProperties
      };
      if(editing)await patch(`owners/${owner.id}`,payload);
      else await post('owners',payload);
      notify(editing?'Propietario actualizado correctamente.':'Propietario creado correctamente.');
      onClose();
      onSaved();
    }catch(error){
      notify(error.message);
    }finally{
      setSaving(false);
    }
  }

  const provinceOptions=geoOptions.provinces.map(province=>province==='CABA'?['CABA','Capital Federal (CABA)']:province);
  const isCaba=form.province==='CABA';
  const localityName=isCaba?'neighborhood':'city';
  const localityLabel=isCaba?'Barrio':'Ciudad';
  const canNotifyByEmail=Boolean(form.email);
  const footer=<>
    <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
    <button className="button primary" form="owner-form" disabled={saving}>{saving?'Guardando…':editing?'Guardar cambios':'Crear propietario'}</button>
  </>;

  return <Modal open={open} title={editing?'Editar propietario':'Nuevo propietario'} subtitle="" onClose={onClose} footer={footer}>
    <form id="owner-form" className="owner-form" onSubmit={submit}>
      <div className="form-row two full">
        <FormField label="Tipo *" name="person_kind" as="select" value={form.person_kind} onChange={change} options={[['PERSON','Persona'],['COMPANY','Empresa']]} />
        <FormField label="Nombre *" name="first_name" value={form.first_name} onChange={change} required />
      </div>
      <div className="form-row two full">
        <FormField label="Apellido *" name="last_name" value={form.last_name} onChange={change} required />
        <FormField label="DNI *" name="document_number" value={form.document_number} onChange={change} required />
      </div>
      <div className="form-row two full">
        <FormField label="CUIT" name="tax_id" value={form.tax_id} onChange={change} />
        <FormField label="Condición frente al IVA" name="vat_condition" as="select" value={form.vat_condition} onChange={change} options={vatConditions} help="Requerido para facturar comisiones al propietario. Para que facture alquileres a inquilinos, debe ser monotributista, responsable inscripto o exento." />
      </div>
      <div className="form-row two full">
        <FormField label="Email" name="email" type="email" value={form.email} onChange={change} />
        <FormField label="Teléfono" name="phone" value={form.phone} onChange={change} />
      </div>
      <FormField label="WhatsApp" name="whatsapp" value={form.whatsapp} onChange={change} />
      <section className="owner-section full">
        <h3>WhatsApp Business</h3>
        <p>Autoriza consultas del propietario y avisos automáticos desde el asistente oficial.</p>
        <label className="switch-row">
          <span>Recibir WhatsApp</span>
          <input type="checkbox" name="whatsapp_opt_in" checked={form.whatsapp_opt_in} onChange={change} />
          <i />
        </label>
        <div className="owner-whatsapp-prefs">
          {[
            ['liquidations','Liquidaciones'],
            ['payments','Pagos y transferencias'],
            ['adjustments','Ajustes'],
            ['expirations','Vencimientos'],
            ['documents','Documentos']
          ].map(([key,label])=><label key={key}><input type="checkbox" name={`whatsapp_pref_${key}`} checked={form.whatsapp_preferences_json?.[key]!==false} disabled={!form.whatsapp_opt_in} onChange={change}/>{label}</label>)}
        </div>
      </section>
      <section className="owner-section full">
        <h3>Avisos de liquidación</h3>
        <p>Recibe un correo cuando se finalice una liquidación en la que participa.</p>
        <label className="switch-row">
          <span>Aviso por correo</span>
          <input type="checkbox" name="liquidation_email_enabled" checked={form.liquidation_email_enabled} disabled={!canNotifyByEmail} onChange={change} />
          <i />
        </label>
        {!canNotifyByEmail&&<small>Para activar el aviso, cargá primero un email válido.</small>}
      </section>
      <div className="form-row two full">
        <FormField label="Dirección" name="address" value={form.address} onChange={change} />
        <FormField label="País" name="country" as="select" value={form.country} onChange={change} options={['Argentina']} />
      </div>
      <div className="form-row two full">
        <FormField label="Provincia" name="province" as="select" value={form.province} onChange={changeProvince} options={[['','Seleccione una provincia'],...provinceOptions]} />
        <FormField key={localityName} label={localityLabel} name={localityName} as="select" value={form[localityName]} onChange={change} disabled={!form.province||loadingLocalities} options={[[ '', loadingLocalities?'Cargando...':`Seleccione ${isCaba?'un barrio':'una ciudad'}` ],...geoOptions.localities]} />
      </div>
      <section className="owner-section fiscal full">
        <h3>Datos fiscales adicionales</h3>
        <p>Se muestran en el PDF de la factura. Ingresos brutos es obligatorio para facturar con ARCA. Si no cargás domicilio fiscal, se usa la dirección del propietario.</p>
      </section>
      <FormField label="Domicilio fiscal" name="fiscal_address" value={form.fiscal_address} onChange={change} placeholder="Si es distinto al domicilio del propietario" full />
      <div className="form-row two full">
        <FormField label="Ingresos brutos" name="gross_income_number" value={form.gross_income_number} onChange={change} placeholder="Ej: CM 901-123456-7 o No contribuye" help="Obligatorio para generar el PDF de la factura" />
        <FormField label="Inicio de actividades" name="activity_start_date" type="date" value={form.activity_start_date} onChange={change} />
      </div>
      <OwnerPropertySelector properties={properties} selected={selectedProperties} setSelected={setSelectedProperties} />
    </form>
  </Modal>;
}
