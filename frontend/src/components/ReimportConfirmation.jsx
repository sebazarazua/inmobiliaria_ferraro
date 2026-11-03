import {Modal} from './Modal';

export function ReimportConfirmation({document,busy,onClose,onConfirm}){
  return <Modal open={Boolean(document)} title="Volver a importar" subtitle={document?.filename||''} onClose={onClose} footer={<><button className="button secondary" type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" type="button" disabled={busy} onClick={onConfirm}>Volver a importar</button></>}>
    <p>Este documento fue importado anteriormente, pero su contrato fue eliminado. ¿Querés volver a procesarlo?</p>
    <p>Se abrirá una nueva revisión. El contrato se creará cuando confirmes sus datos; las lecturas anteriores quedan en el historial.</p>
  </Modal>;
}
