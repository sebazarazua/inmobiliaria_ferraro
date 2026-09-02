import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '../api/client';

export function useApi(path){
  const [data,setData]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(true);
  const hasDataRef=useRef(false);
  useEffect(()=>{hasDataRef.current=data!=null;},[data]);
  const reload=useCallback(async(options={})=>{if(!options.silent||!hasDataRef.current)setLoading(true);if(!options.silent)setError(null);try{setData(await api(path));}catch(err){if(!options.silent)setError(err);}finally{if(!options.silent||!hasDataRef.current)setLoading(false);}},[path]);
  useEffect(()=>{reload();},[reload]);
  return{data,error,loading,reload,setData};
}
