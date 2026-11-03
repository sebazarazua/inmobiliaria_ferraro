export const UPDATE_OPTIONS=[['IPC','Por IPC (INDEC)'],['ICL','Por ICL'],['CAC','Por índice CAC'],['FIXED_PERCENTAGE','Por porcentaje fijo'],['MANUAL','Según acuerdo de las partes'],['CUSTOM_INDEX','Otro mecanismo contractual']];
export const FREQUENCY_OPTIONS=[['3','Cada 3 meses'],['4','Cada 4 meses'],['6','Cada 6 meses'],['12','Cada 12 meses'],['other','Otra frecuencia']];
export const LATE_FEE_OPTIONS=[['NONE','Sin intereses por demora'],['FIXED_DAILY','Porcentaje diario fijo'],['BANK_ACTIVE_RATE','Tasa activa del Banco Nación']];
const pairs={IPC:['IPC','IPC'],ICL:['ICL','ICL'],CAC:['CUSTOM_INDEX','CAC'],FIXED_PERCENTAGE:['FIXED_PERCENTAGE',null],MANUAL:['MANUAL',null],CUSTOM_INDEX:['CUSTOM_INDEX',null]};

// Read legacy pairs without rewriting them. Conflicting conditions require an explicit choice.
export function updateMethod(terms={}){
  const type=terms.adjustment_type,index=terms.adjustment_index;
  if(type==='FIXED_PERCENTAGE')return !index||index==='Acuerdo de partes'?'FIXED_PERCENTAGE':'';
  if(type==='MANUAL')return !index||index==='Acuerdo de partes'?'MANUAL':'';
  if(index==='CAC')return !type||['CAC','CUSTOM_INDEX'].includes(type)?'CAC':'';
  if(index==='IPC'||index==='ICL')return !type||type===index?index:'';
  if(type==='IPC'||type==='ICL')return ''; // An index missing from an existing pair requires explicit review.
  if(type==='CUSTOM_INDEX'||index)return 'CUSTOM_INDEX';
  return '';
}
export function selectUpdateMethod(method){
  const pair=pairs[method];
  return pair?{adjustment_type:pair[0],adjustment_index:pair[1]}:{};
}
export const updateLabel=terms=>UPDATE_OPTIONS.find(([key])=>key===updateMethod(terms))?.[1]||'Requiere revisar las condiciones';
export function validateUpdateTerms(terms){
  const method=updateMethod(terms);
  if(!method)throw new Error('Revisá cómo se actualiza el alquiler: elegí un mecanismo coherente con el contrato.');
  if(method==='FIXED_PERCENTAGE'&&(terms.adjustment_value_pct===''||terms.adjustment_value_pct==null||!Number.isFinite(Number(terms.adjustment_value_pct))||Number(terms.adjustment_value_pct)<0))throw new Error('Indicá el porcentaje fijo del aumento.');
  if(method==='CUSTOM_INDEX'&&!String(terms.adjustment_index||terms.notes||'').trim())throw new Error('Indicá el mecanismo o sus condiciones contractuales.');
}
export function nextAdjustmentPeriod(terms,period){
  const start=String(terms.start_date||'').slice(0,7),frequency=Number(terms.adjustment_frequency_months);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||!Number.isInteger(frequency)||frequency<1)return null;
  const [y,m]=start.split('-').map(Number),[py,pm]=period.split('-').map(Number),elapsed=(py-y)*12+pm-m;
  if(elapsed<0)return null;
  const next=new Date(Date.UTC(y,m-1+(Math.floor(elapsed/frequency)+1)*frequency,1)).toISOString().slice(0,7);
  return terms.end_date&&next>String(terms.end_date).slice(0,7)?null:next;
}
