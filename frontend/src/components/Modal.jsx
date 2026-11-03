import {useEffect,useRef} from 'react';
import {Icon} from './Icon';
export function Modal({open,title,subtitle='',onClose,children,footer}){
  const ref=useRef(null);
  useEffect(()=>{
    const dialog=ref.current;
    if(!open){if(dialog.open)dialog.close();return;}
    const previous=document.activeElement;
    if(!dialog.open)dialog.showModal();
    return()=>{if(dialog.open)dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
  },[open]);
  return <dialog ref={ref} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}><div className="modal"><div className="modal-head"><div><h2>{title}</h2>{subtitle&&<p className="modal-subtitle">{subtitle}</p>}</div><button className="icon-button" type="button" onClick={onClose} aria-label="Cerrar"><Icon name="close" size={18}/></button></div>{children}{footer&&<div className="modal-actions">{footer}</div>}</div></dialog>;
}
