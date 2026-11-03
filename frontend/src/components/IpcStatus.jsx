export function IpcStatus({row}) {
  const calculation=row.calculation_json;
  return <>
    {row.ipc_requires_reconciliation&&<small className="ipc-pending">IPC histórico: requiere conciliación</small>}
    {row.adjustment_pending&&<small className="ipc-pending">{row.adjustment_index&&row.adjustment_index!=='IPC'?'Requiere ajuste contractual':`Importe provisional · falta IPC ${calculation?.missingPeriods?.join(', ')||'oficial'}`}</small>}
    {row.rent_override_amount!=null&&<small>Importe manual · canon contractual {Number(row.contractual_amount).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})}</small>}
    {calculation?.steps?.length>0&&<details><summary>Detalle del ajuste IPC</summary><small>Base: {calculation.basePeriod} · rezago: {calculation.referenceOffsetMonths} mes(es) · frecuencia: {calculation.frequencyMonths} meses</small>{calculation.steps.map(step=><small key={step.effectivePeriod}>{step.effectivePeriod}: {step.baseIndex} → {step.targetIndex} ({step.comparisonPeriod}) · coeficiente {step.coefficient} · {step.source}</small>)}</details>}
  </>;
}
