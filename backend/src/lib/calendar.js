// PostgreSQL DATE is a local civil date in node-postgres, not an instant.
function dateKey(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Fecha inválida.');
    // pg creates local midnight; ISO Date constructors commonly create UTC midnight.
    if(value.getHours()!==0||value.getMinutes()!==0||value.getSeconds()!==0)return value.toISOString().slice(0,10);
    return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  }
  const text=String(value??'');
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(text)) throw new Error('La fecha debe tener formato YYYY-MM-DD.');
  const key=text.slice(0,10),[year,month,day]=key.split('-').map(Number);
  if (month<1||month>12||day<1||day>daysInMonth(year,month)) throw new Error('Fecha inválida.');
  return key;
}
function periodKey(value) {
  if (typeof value==='string'&&/^\d{4}-\d{2}$/.test(value)) {
    if (+value.slice(5)<1||+value.slice(5)>12) throw new Error('Período inválido.');
    return value;
  }
  return dateKey(value).slice(0,7);
}
function daysInMonth(year,month) { return new Date(Date.UTC(year,month,0)).getUTCDate(); }
function shiftMonth(value,offset) {
  if (!Number.isInteger(offset)) throw new Error('El desplazamiento debe ser un número entero de meses.');
  const [year,month]=periodKey(value).split('-').map(Number),date=new Date(Date.UTC(year,month-1+offset,1));
  return date.toISOString().slice(0,7);
}
function monthsBetween(start,target) {
  const [sy,sm]=periodKey(start).split('-').map(Number),[ty,tm]=periodKey(target).split('-').map(Number);
  return (ty-sy)*12+tm-sm;
}
function addMonths(value,offset) {
  const date=dateKey(value),period=shiftMonth(date,offset),[year,month]=period.split('-').map(Number);
  return `${period}-${String(Math.min(+date.slice(8),daysInMonth(year,month))).padStart(2,'0')}`;
}
function dueDate(period,day=10) {
  const key=periodKey(period),[year,month]=key.split('-').map(Number);
  if (!Number.isInteger(Number(day))||day<1||day>31) throw new Error('Día de vencimiento inválido.');
  return `${key}-${String(Math.min(Number(day),daysInMonth(year,month))).padStart(2,'0')}`;
}
module.exports={dateKey,periodKey,shiftMonth,monthsBetween,addMonths,dueDate};
