// Decimal arithmetic without converting a monetary calculation to binary floats.
function scaled(value,places=2) {
  let text=String(value??0);
  if (/e/i.test(text)) text=Number(text).toFixed(places+2);
  const match=text.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('Importe o índice decimal inválido.');
  const fraction=match[3]||'',factor=10n**BigInt(places);
  let units=BigInt(match[2])*factor+BigInt(fraction.slice(0,places).padEnd(places,'0')||0);
  if (Number(fraction[places]||0)>=5) units+=1n;
  return match[1]?-units:units;
}
function decimal(units,places=2) {
  const sign=units<0n?'-':'',abs=units<0n?-units:units,text=abs.toString().padStart(places+1,'0');
  return places?`${sign}${text.slice(0,-places)}.${text.slice(-places)}`:`${sign}${text}`;
}
function adjustedMoney(amount,base,target) {
  const cents=scaled(amount),denominator=scaled(base,10),numerator=scaled(target,10);
  if(cents<0n||denominator<=0n||numerator<=0n)throw new Error('Canon e índices fuera de rango.');
  const result=(cents*numerator+denominator/2n)/denominator;
  if(result>99999999999999n)throw new Error('El canon supera numeric(14,2).');
  return decimal(result);
}
function coefficient(base,target) {
  const denominator=scaled(base,10),numerator=scaled(target,10);
  return decimal((numerator*10n**12n+denominator/2n)/denominator,12);
}
function balance(row,paid=row.paid_amount||0) {
  return decimal(scaled(row.expected_amount)+scaled(row.vat_amount)+scaled(row.late_fee_amount)-scaled(row.discount_amount)-scaled(paid));
}
function paymentStatus(row,paid) {
  if(row.status==='Sustituido')return row.status;
  if(scaled(balance(row,paid))<=0n&&!row.adjustment_pending)return 'Pagado';
  return scaled(paid)>0n?'Parcial':row.status==='Vencido'?'Vencido':'Pendiente';
}
module.exports={scaled,decimal,adjustedMoney,coefficient,balance,paymentStatus};
