import React,{useCallback,useEffect,useState} from 'react';
import {api} from './api/client';
import {Layout} from './components/Layout';
import {useHashRoute} from './hooks/useHashRoute';
import {DashboardPage} from './pages/DashboardPage';
import {ResourcePage} from './pages/ResourcePage';
import {SettingsPage} from './pages/SettingsPage';
import {WhatsAppPage} from './pages/WhatsAppPage';

class ErrorBoundary extends React.Component{
  constructor(props){super(props);this.state={error:null};}
  static getDerivedStateFromError(error){return{error};}
  componentDidUpdate(previous){if(previous.resetKey!==this.props.resetKey&&this.state.error)this.setState({error:null});}
  render(){if(!this.state.error)return this.props.children;return <div className="error-view"><b>!</b><h2>No pudimos cargar esta sección</h2><p>{this.state.error.message}</p><button className="button secondary" onClick={()=>this.setState({error:null})}>Reintentar</button></div>;}
}

export function App(){
  const route=useHashRoute();
  const[reviews,setReviews]=useState(0),[scanning,setScanning]=useState(false),[toast,setToast]=useState(''),[resetKey,setResetKey]=useState(0);
  const notify=useCallback(message=>{setToast(message);setTimeout(()=>setToast(''),2600);},[]);
  useEffect(()=>{api('dashboard').then(data=>setReviews(data.kpis.reviews)).catch(()=>{});},[route,resetKey]);
  async function scan(){setScanning(true);try{const result=await api('imports/scan',{method:'POST'});notify(`${result.imported} contrato${result.imported===1?'':'s'} nuevo${result.imported===1?'':'s'}.`);setResetKey(value=>value+1);}catch(error){notify(error.message);}finally{setScanning(false);}}
  const page=route==='dashboard'?<DashboardPage/>:route==='settings'?<SettingsPage notify={notify}/>:route==='whatsapp'?<WhatsAppPage notify={notify}/>:<ResourcePage resource={route} notify={notify}/>;
  return <Layout route={route} reviews={reviews} onScan={scan} scanning={scanning}><ErrorBoundary resetKey={`${route}-${resetKey}`}><div key={`${route}-${resetKey}`}>{page}</div></ErrorBoundary><div className={`toast ${toast?'show':''}`}>{toast}</div></Layout>;
}
