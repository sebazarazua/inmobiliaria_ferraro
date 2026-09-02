export const money=(value,currency='ARS')=>value==null?'—':new Intl.NumberFormat('es-AR',{style:'currency',currency,maximumFractionDigits:0}).format(Number(value));
export const shortDate=value=>value?new Intl.DateTimeFormat('es-AR',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${String(value).slice(0,10)}T00:00:00Z`)):'—';
export const today=()=>new Date().toISOString().slice(0,10);
export const installmentStatus=row=>row.status!=='Pagado'&&String(row.due_date).slice(0,10)<today()?'Vencido':row.status;
