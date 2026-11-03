const {dateKey,periodKey,shiftMonth,monthsBetween}=require('../../lib/calendar');
const {adjustedMoney,coefficient,decimal,scaled}=require('../../lib/money');

function validateIpcContract(contract) {
  periodKey(contract.start_date);
  if(!Number.isInteger(Number(contract.adjustment_frequency_months))||Number(contract.adjustment_frequency_months)<1)throw new Error('IPC requiere una frecuencia entera positiva.');
  if(!Number.isInteger(Number(contract.ipc_lag_months||0))||Number(contract.ipc_lag_months||0)<0)throw new Error('Rezago IPC inválido.');
  if(scaled(contract.initial_amount)<0n)throw new Error('El canon inicial no puede ser negativo.');
}

// Pure calculation. External I/O is confined to store.refreshOfficialIndices.
// Lag is distance from the effective month: 0 preserves the legacy previous-month
// convention, 1 explicitly means previous month, 2 means two months before.
function calculateIpcAmount(contract,installmentPeriod,data={series:new Map()}) {
  const amount=decimal(scaled(contract?.initial_amount||0));
  if(!contract||contract.adjustment_index!=='IPC'){
    const frequency=Number(contract?.adjustment_frequency_months||0);
    const pendingManualAdjustment=Boolean(contract?.start_date&&frequency>0&&monthsBetween(contract.start_date,installmentPeriod)>=frequency);
    return {amount:Number(amount),amountDecimal:amount,applied:false,pendingOfficialData:false,pendingManualAdjustment};
  }
  validateIpcContract(contract);
  const start=periodKey(contract.start_date),period=periodKey(installmentPeriod),diff=monthsBetween(start,period);
  if(diff<0)throw new Error('La cuota es anterior al inicio del contrato.');
  const frequency=Number(contract.adjustment_frequency_months),lag=Number(contract.ipc_lag_months||0),offset=Math.max(1,lag),segments=Math.floor(diff/frequency);
  const basePeriod=shiftMonth(start,-offset),requestedEffectivePeriod=shiftMonth(start,segments*frequency),requestedComparisonPeriod=shiftMonth(requestedEffectivePeriod,-offset);
  const raw=data.series||new Map(),get=p=>{const item=raw.get(p);return item==null?null:typeof item==='object'?{...item,value:item.value??item.index_value}:{value:String(item)};};
  const base=get(basePeriod);let latestAmount=amount,lastSegment=0,lastTarget=null,lastEffective=start,missing=[];const steps=[];
  for(let k=1;k<=segments;k++){
    const effective=shiftMonth(start,k*frequency),targetPeriod=shiftMonth(effective,-offset),target=get(targetPeriod);
    if(!base||!target){missing=[...new Set([...(!base?[basePeriod]:[]),...(!target?[targetPeriod]:[])])];break;}
    const previousAmount=latestAmount;
    latestAmount=adjustedMoney(amount,base.value,target.value);lastSegment=k;lastTarget=targetPeriod;lastEffective=effective;
    steps.push({effectivePeriod:effective,basePeriod,comparisonPeriod:targetPeriod,baseIndex:base.value,targetIndex:target.value,baseVersion:base.id||null,targetVersion:target.id||null,coefficient:coefficient(base.value,target.value),previousAmount,amount:latestAmount,source:target.source||data.source||null,sourceUrl:target.source_url||data.sourceUrl||null,fetchedAt:target.fetched_at||data.fetchedAt||null});
  }
  return {
    amount:Number(latestAmount),amountDecimal:latestAmount,applied:lastSegment>0,pendingOfficialData:lastSegment<segments,
    effectivePeriod:lastEffective,requestedEffectivePeriod,basePeriod,comparisonPeriod:lastTarget,requestedComparisonPeriod,
    sourcePeriod:lastTarget,latestOfficialPeriod:data.latestPeriod||null,frequencyMonths:frequency,lagMonths:lag,referenceOffsetMonths:offset,
    adjustmentsDue:segments,adjustmentsApplied:lastSegment,missingPeriods:missing,steps,
    contract:{start_date:dateKey(contract.start_date),initial_amount:amount,adjustment_index:'IPC',adjustment_frequency_months:frequency,ipc_lag_months:lag},
    rounding:'initial_amount × final_index / base_index; decimal half-up to cents; no intermediate rounding'
  };
}
async function adjustedAmountByIpc(contract,period,data) {return calculateIpcAmount(contract,period,data);}
module.exports={calculateIpcAmount,adjustedAmountByIpc,validateIpcContract};
