// Shared browser interaction: use the public month/year picker, never OS month inputs.
const choosePeriodSource=`async function choosePeriod(page,period){
  await page.getByRole('button',{name:'Filtrar por mes de cobro:',exact:false}).click();
  const picker=page.getByRole('dialog',{name:'Elegir mes y año',exact:true});await picker.waitFor();
  if(!period){await picker.getByRole('button',{name:'Todos los meses',exact:true}).click();return;}
  await picker.getByLabel('Año del período',{exact:true}).fill(period.slice(0,4));
  await picker.locator('[data-period="'+period+'"]').click();
}`;
module.exports={choosePeriodSource};
