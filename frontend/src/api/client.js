export async function api(path,options={}){
  const response=await fetch(`/api/${path}`,{headers:{'Content-Type':'application/json'},...options});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'No se pudo completar la operación.');
  return payload;
}
export const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
export const patch=(path,data)=>api(path,{method:'PATCH',body:JSON.stringify(data)});
export const put=(path,data)=>api(path,{method:'PUT',body:JSON.stringify(data)});
