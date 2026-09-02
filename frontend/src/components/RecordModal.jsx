import {useEffect,useState} from 'react';
import {api,post} from '../api/client';
import {FormField} from './FormField';
import {Modal} from './Modal';
import {today} from '../utils/format';

const propertyTypes=[
  'Departamento',
  'Casa',
  'PH',
  'Quinta',
  'Garage',
  'Oficina Comercial',
  'Local Comercial',
  'Bodega/Galpón',
  'Depósito',
  'Campo',
  'Terreno/Lote'
];

const rentalTypes=['Residencial','Comercial','Profesional','Temporario','Otro'];

function collectForm(form){
  return Object.fromEntries(new FormData(form));
}

function PropertyOwnerPicker({people,selected,setSelected,multiple,setMultiple}){
  const ownerOptions=people.map(item=>[item.id,`${item.full_name}${item.document_number?` · ${item.document_number}`:''}`]);
  const toggleOwner=id=>setSelected(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  return <section className="property-owner-picker full">
    <FormField
      label="Propietario"
      name="owner_id"
      as="select"
      value={multiple?'':selected[0]||''}
      onChange={event=>setSelected(event.target.value?[event.target.value]:[])}
      disabled={multiple}
      options={[['','Sin propietario asignado'],...ownerOptions]}
    />
    <label className="checkbox-line">
      <input type="checkbox" checked={multiple} onChange={event=>{setMultiple(event.target.checked);setSelected([]);}} />
      <span>Esta propiedad tiene múltiples propietarios</span>
    </label>
    {multiple&&<div className="owner-checklist">
      {people.length?people.map(person=><label key={person.id}>
        <input type="checkbox" checked={selected.includes(person.id)} onChange={()=>toggleOwner(person.id)} />
        <span>{person.full_name}</span>
        {person.document_number&&<small>{person.document_number}</small>}
      </label>):<p>No hay propietarios/personas cargadas todavía. Primero creá la persona y luego asociá la propiedad.</p>}
    </div>}
  </section>;
}

function PropertyForm({people,selectedOwners,setSelectedOwners,multipleOwners,setMultipleOwners,geoOptions,onProvinceChange,selectedProvince,loadingLocalities}){
  const isCaba=selectedProvince==='CABA';
  const localityLabel=isCaba?'Barrio':'Ciudad';
  const localityName=isCaba?'neighborhood':'city';
  const provinceOptions=geoOptions.provinces.map(province=>province==='CABA'?['CABA','Capital Federal (CABA)']:province);
  return <>
    <div className="form-row three full">
      <FormField label="País" name="country" as="select" defaultValue="Argentina" required options={['Argentina']} />
      <FormField label="Provincia" name="province" as="select" value={selectedProvince} onChange={event=>onProvinceChange(event.target.value)} required options={[['','Seleccione una provincia'],...provinceOptions]} />
      <FormField key={localityName} label={localityLabel} name={localityName} as="select" disabled={!selectedProvince||loadingLocalities} required options={[[ '', loadingLocalities?'Cargando...':`Seleccione ${isCaba?'un barrio':'una ciudad'}` ],...geoOptions.localities]} />
    </div>
    <FormField label="Dirección" name="address" placeholder="Ej: Solís 637 1° G" full required help="Cargala completa. El sistema interpreta número, piso y departamento internamente." />
    <FormField label="Tipo de propiedad" name="property_type" as="select" options={[['','Seleccione el tipo de propiedad'],...propertyTypes]} full required />
    <PropertyOwnerPicker people={people} selected={selectedOwners} setSelected={setSelectedOwners} multiple={multipleOwners} setMultiple={setMultipleOwners} />
    <div className="form-row three full">
      <FormField label="Tamaño (m²)" name="size_m2" type="number" min="0" step="0.01" placeholder="Ej: 120" />
      <FormField label="Dormitorios" name="bedrooms" type="number" min="0" placeholder="Ej: 3" />
      <FormField label="Baños" name="bathrooms" type="number" min="0" placeholder="Ej: 2" />
    </div>
    <FormField label="Valor de mercado (USD)" name="market_value_usd" type="number" min="0" step="0.01" placeholder="Ej: 150000" full />
    <FormField label="Estado" name="status" as="select" options={['Disponible','Alquilada','Inactiva']} defaultValue="Disponible" />
    <FormField label="Código interno" name="code" placeholder="Se genera automático si lo dejás vacío" />
    <FormField label="Notas" name="notes" as="textarea" full />
  </>;
}

export function RecordModal({resource,open,onClose,onSaved,notify}){
  const[options,setOptions]=useState({properties:[],people:[]});
  const[geoOptions,setGeoOptions]=useState({provinces:[],localities:[]});
  const[selectedProvince,setSelectedProvince]=useState('');
  const[loadingLocalities,setLoadingLocalities]=useState(false);
  const[saving,setSaving]=useState(false);
  const[selectedOwners,setSelectedOwners]=useState([]);
  const[multipleOwners,setMultipleOwners]=useState(false);

  useEffect(()=>{
    if(!open)return;
    setSelectedOwners([]);
    setMultipleOwners(false);
    setSelectedProvince('');
    setGeoOptions(current=>({...current,localities:[]}));
    if(!['contracts','incidents','ledger','expenses','services','other-income','properties'].includes(resource))return;
    Promise.all([
      ['contracts','incidents','ledger','expenses','services','other-income'].includes(resource)?api('properties'):Promise.resolve([]),
      ['contracts','properties'].includes(resource)?api('people'):Promise.resolve([]),
      resource==='properties'?api('geo/provinces'):Promise.resolve({provinces:[]})
    ]).then(([properties,people,geo])=>setOptions({properties,people})||setGeoOptions(current=>({...current,provinces:geo.provinces||[]}))).catch(error=>notify(error.message));
  },[open,resource,notify]);

  async function changeProvince(province){
    setSelectedProvince(province);
    setGeoOptions(current=>({...current,localities:[]}));
    if(!province)return;
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

  async function submit(event){
    event.preventDefault();
    setSaving(true);
    try{
      const payload=collectForm(event.currentTarget);
      if(resource==='properties')payload.owner_ids=selectedOwners;
      await post(resource,payload);
      notify('Registro guardado correctamente.');
      onClose();
      onSaved();
    }catch(error){
      notify(error.message);
    }finally{
      setSaving(false);
    }
  }

  const modalTitle=`Agregar ${resource==='owners'?'propietario':resource==='people'?'persona':['ledger','expenses','services','other-income'].includes(resource)?'movimiento':resource==='incidents'?'incidencia':resource==='properties'?'propiedad':'contrato'}`;
  return <Modal
    open={open}
    title={modalTitle}
    subtitle={resource==='properties'?'Complete los detalles de la propiedad':undefined}
    onClose={onClose}
    footer={<><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" form="record-form" disabled={saving}>{saving?'Guardando…':'Guardar'}</button></>}
  >
    <form id="record-form" className={`form-grid ${resource==='properties'?'property-form':''}`} onSubmit={submit}>
      {resource==='properties'&&<PropertyForm people={options.people} selectedOwners={selectedOwners} setSelectedOwners={setSelectedOwners} multipleOwners={multipleOwners} setMultipleOwners={setMultipleOwners} geoOptions={geoOptions} selectedProvince={selectedProvince} onProvinceChange={changeProvince} loadingLocalities={loadingLocalities} />}
      {(resource==='people'||resource==='owners')&&<><FormField label="Tipo" name="person_kind" as="select" options={[['PERSON','Persona'],['COMPANY','Empresa']]}/><FormField label="Nombre completo / razón social" name="full_name" required/><FormField label="DNI / CUIT" name="document_number"/><FormField label="Tipo de documento" name="document_type" as="select" options={['DNI','CUIT','Pasaporte']}/><FormField label="Correo electrónico" name="email" type="email"/><FormField label="Teléfono" name="phone"/><FormField label="Domicilio" name="address" full/></>}
      {resource==='incidents'&&<><FormField label="Título" name="title" required/><FormField label="Propiedad" name="property_id" as="select" options={[['','General'],...options.properties.map(item=>[item.id,item.address])]}/><FormField label="Prioridad" name="priority" as="select" options={['Baja','Media','Alta','Urgente']} defaultValue="Media"/><FormField label="Estado" name="status" as="select" options={['Abierta','En seguimiento']}/><FormField label="Descripción" name="description" as="textarea" full/></>}
      {['ledger','expenses','services','other-income'].includes(resource)&&<><FormField label="Fecha" name="entry_date" type="date" defaultValue={today()} required/><FormField label="Tipo" name="kind" as="select" options={['Ingreso','Gasto']} defaultValue={resource==='other-income'?'Ingreso':'Gasto'}/><FormField label="Categoría" name="category" defaultValue={resource==='services'?'Servicio':'General'} required/><FormField label="Importe" name="amount" type="number" min="0" step="0.01" required/><FormField label="Descripción" name="description" full required/><FormField label="Propiedad" name="property_id" as="select" options={[['','Movimiento general'],...options.properties.map(item=>[item.id,item.address])]} full/></>}
      {resource==='contracts'&&<><FormField label="Código" name="code" required/><FormField label="Tipo de alquiler" name="rental_type" as="select" options={rentalTypes}/><FormField label="Propiedad" name="property_id" as="select" options={options.properties.map(item=>[item.id,item.address])}/><FormField label="Inquilino" name="tenant_id" as="select" options={options.people.map(item=>[item.id,item.full_name])}/><FormField label="Propietario" name="owner_id" as="select" options={options.people.map(item=>[item.id,item.full_name])}/><FormField label="Duración (meses)" name="duration_months" type="number" min="1" defaultValue="24" required help="La finalización se calcula automáticamente."/><FormField label="Inicio" name="start_date" type="date" required/><FormField label="Canon inicial" name="initial_amount" type="number" min="0" step="0.01" required/><FormField label="Honorario (%)" name="management_fee_pct" type="number" min="2" max="5" step="0.1" defaultValue="3" required/><FormField label="Moneda" name="currency" as="select" options={['ARS','USD']}/><FormField label="Ajuste cada (meses)" name="adjustment_frequency_months" type="number" defaultValue="4"/><FormField label="Índice" name="adjustment_index" as="select" options={['IPC','ICL','CAC','Acuerdo de partes']}/><FormField label="Día de vencimiento" name="payment_due_day" type="number" min="1" max="31" defaultValue="10"/><FormField label="Respaldo" name="guarantee_type" as="select" options={['Seguro de caución','Garantía propietaria','Sin garantía','Otra']}/><FormField label="Empresa" name="guarantee_provider" as="select" options={['Respaldar','Argenprop','Otra']}/><FormField label="Detalle de garantía" name="guarantee_provider_detail"/><FormField label="Estado" name="status" as="select" options={['Activo','Borrador','Revisión']}/></>}
    </form>
  </Modal>;
}
