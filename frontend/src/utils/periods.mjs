const PERIOD_PATTERN=/^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod=value=>PERIOD_PATTERN.test(String(value||''));
export const periodOf=row=>String(row?.period||'').slice(0,7);
export function filterByPeriod(rows=[],period=''){if(!isPeriod(period))return rows;return rows.filter(row=>periodOf(row)===period);}
export function formatPeriod(period){if(!isPeriod(period))return'Todos los meses';const[year,month]=period.split('-').map(Number);const label=new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric',timeZone:'UTC'}).format((()=>{const date=new Date(0);date.setUTCFullYear(year,month-1,1);return date;})());return label.charAt(0).toUpperCase()+label.slice(1);}

// Presentation only: aggregate the authoritative due_amount already returned by the API.
export function totalsByCurrency(rows=[]){
  const totals=new Map();
  for(const row of rows){
    const currency=row.currency||'ARS',text=String(row.due_amount??0),match=text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if(!match)throw new Error('Saldo pendiente inválido para el resumen mensual.');
    const cents=BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0'));
    totals.set(currency,(totals.get(currency)||0n)+cents);
  }
  return [...totals].sort(([a],[b])=>a.localeCompare(b)).map(([currency,cents])=>({currency,amount:`${cents/100n}.${String(cents%100n).padStart(2,'0')}`}));
}
export function groupByPeriod(rows=[]){
  const groups=new Map();
  for(const row of rows){const period=isPeriod(periodOf(row))?periodOf(row):'';if(!groups.has(period))groups.set(period,[]);groups.get(period).push(row);}
  return [...groups].sort(([a],[b])=>(a||'9999-99').localeCompare(b||'9999-99')).map(([period,items])=>({period,label:period?formatPeriod(period):'Período por revisar',rows:[...items].sort((a,b)=>String(a.due_date||'9999').localeCompare(String(b.due_date||'9999'))||String(a.id).localeCompare(String(b.id))),count:items.length,totals:totalsByCurrency(items)}));
}
