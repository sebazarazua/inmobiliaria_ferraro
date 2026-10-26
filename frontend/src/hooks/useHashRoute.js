import {useEffect,useState} from 'react';
const allowed=new Set(['dashboard','contracts','properties','owners','tenants','guarantors','collections','pending-collections','expenses','services','other-income','whatsapp','incidents','documents','imports','settings']);
const read=()=>{const value=location.hash.slice(1).split('?')[0]||'dashboard';return allowed.has(value)?value:'dashboard';};
export const hashParam=name=>new URLSearchParams(location.hash.split('?')[1]||'').get(name)||'';
export function useHashRoute(){const[route,setRoute]=useState(read);useEffect(()=>{const handler=()=>setRoute(read());addEventListener('hashchange',handler);return()=>removeEventListener('hashchange',handler);},[]);return route;}
