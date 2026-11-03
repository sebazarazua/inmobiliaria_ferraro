export function IpcStatus({row}) {
  return <>
    {row.ipc_requires_reconciliation&&<small className="ipc-pending">Requiere conciliación</small>}
    {row.adjustment_pending&&<small className="ipc-pending">{row.adjustment_index==='IPC'?'IPC pendiente':'Actualización manual'}</small>}
    {(row.rent_override_amount!=null||row.rent_forgiven)&&<small className="ipc-pending">Importe manual</small>}
  </>;
}
