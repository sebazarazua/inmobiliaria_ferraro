const PERIOD_PATTERN=/^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod=value=>PERIOD_PATTERN.test(String(value||''));
export const periodOf=row=>String(row?.period||'').slice(0,7);
export function filterByPeriod(rows=[],period=''){if(!isPeriod(period))return rows;return rows.filter(row=>periodOf(row)===period);}
export function formatPeriod(period){if(!isPeriod(period))return'Todos los meses';const[year,month]=period.split('-').map(Number);const label=new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(year,month-1,1)));return label.charAt(0).toUpperCase()+label.slice(1);}
