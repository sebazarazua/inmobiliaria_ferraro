import {useId} from 'react';
export function FormField({label,help,full,as='input',options=[],...props}){
  const generated=useId(),id=props.id||generated,Tag=as;
  const accessible={...props,id,'aria-labelledby':`${id}-label`,'aria-describedby':help?`${id}-help`:props['aria-describedby']};
  return <label htmlFor={id} className={`field ${full?'full':''}`}><span id={`${id}-label`}>{label}</span>{as==='select'?<select {...accessible}>{options.map(option=>{const[value,text]=Array.isArray(option)?option:[option,option];return <option key={value} value={value}>{text}</option>})}</select>:<Tag {...accessible}/>} {help&&<small id={`${id}-help`}>{help}</small>}</label>;
}
