import {useEffect,useId,useRef,useState} from 'react';
import {formatPeriod,isPeriod} from '../utils/periods.mjs';
const monthNames=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
export function MonthYearPicker({value='',onChange}){
  const [open,setOpen]=useState(false),[year,setYear]=useState(()=>isPeriod(value)?value.slice(0,4):String(new Date().getFullYear())),[active,setActive]=useState(0);
  const root=useRef(null),trigger=useRef(null),months=useRef([]),id=useId(),validYear=/^\d{1,4}$/.test(year)&&Number(year)>=1&&Number(year)<=9999;
  const close=()=>{setOpen(false);trigger.current?.focus();};
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!root.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  function show(){if(open){close();return;}const selected=isPeriod(value)?Number(value.slice(5))-1:0;setActive(selected);setYear(isPeriod(value)?value.slice(0,4):String(new Date().getFullYear()));setOpen(true);}
  useEffect(()=>{if(open)months.current[active]?.focus();},[open]);
  function shiftYear(offset){const next=Math.min(9999,Math.max(1,(Number(year)||new Date().getFullYear())+offset));setYear(String(next));}
  function key(event,index){
    const offsets={ArrowRight:1,ArrowLeft:-1,ArrowDown:3,ArrowUp:-3};let next;
    if(event.key in offsets)next=(index+offsets[event.key]+12)%12;
    else if(event.key==='Home')next=0;else if(event.key==='End')next=11;
    else if(event.key==='PageUp'||event.key==='PageDown'){event.preventDefault();shiftYear((event.key==='PageUp'?-1:1)*(event.shiftKey?10:1));return;}
    if(next!==undefined){event.preventDefault();setActive(next);months.current[next]?.focus();}
  }
  return <div className="month-year-picker" ref={root} onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))setOpen(false);}} onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close();}}}>
    <span className="month-picker-label">Mes de cobro</span>
    <button type="button" className="button secondary month-picker-trigger" ref={trigger} aria-label={`Filtrar por mes de cobro: ${formatPeriod(value)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={show}>{formatPeriod(value)} <span aria-hidden="true">▾</span></button>
    {open&&<div className="month-picker-popover" id={id} role="dialog" aria-label="Elegir mes y año">
      <div className="month-picker-year"><button type="button" className="button small secondary" aria-label="Año anterior" disabled={Number(year)<=1} onClick={()=>shiftYear(-1)}>‹</button><label><span>Año</span><input aria-label="Año del período" type="number" min="1" max="9999" value={year} onChange={event=>setYear(event.target.value)}/></label><button type="button" className="button small secondary" aria-label="Año siguiente" disabled={Number(year)>=9999} onClick={()=>shiftYear(1)}>›</button></div>
      {!validYear&&<p role="status">Ingresá un año entre 1 y 9999.</p>}
      <div className="month-picker-months" role="group" aria-label="Meses del año">{monthNames.map((name,index)=>{const period=`${String(Number(year)).padStart(4,'0')}-${String(index+1).padStart(2,'0')}`;return <button type="button" key={name} ref={el=>{months.current[index]=el;}} className={value===period?'selected':''} aria-label={`Seleccionar ${name} ${year}`} aria-pressed={value===period} data-period={period} disabled={!validYear} tabIndex={active===index?0:-1} onFocus={()=>setActive(index)} onKeyDown={event=>key(event,index)} onClick={()=>{onChange(period);close();}}>{name}</button>;})}</div>
      <button type="button" className="button secondary" onClick={()=>{onChange('');close();}}>Todos los meses</button>
    </div>}
  </div>;
}
