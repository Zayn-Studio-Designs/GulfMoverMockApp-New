import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ProdPageHeader, NotConnectedView, dataErrorKey } from '../components/ProductionUi';
import { records, operation } from '../lib/operationsService';
interface Notification { id:string;kind:string;target:string;created_at:string;read_at:string|null }
/** Database triggers choose targets, but still allow-list links before rendering. */
function safeTarget(target:string){return /^\/(onboarding|company\/members|bookings(?:\/GM-[A-Z0-9]+)?|materials|charters|admin\/materials|admin\/charters)$/.test(target)?target:'/onboarding';}
export default function NotificationsView(){
 const {authMode,user}=useAuth();const {t}=useLanguage();const [rows,setRows]=useState<Notification[]>([]);const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [busy,setBusy]=useState('');const [revision,setRevision]=useState(0);
 useEffect(()=>{let alive=true;if(authMode!=='production')return;setLoading(true);setRows([]);setError('');void records<Notification>('notifications','id,kind,target,created_at,read_at').then(r=>{if(alive)setRows(r);}).catch(e=>{if(alive)setError(dataErrorKey(e));}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[authMode,user?.id,revision]);
 async function read(id:string){setBusy(id);setError('');try{await operation<boolean>('mark_notification_read',{p_id:id});setRevision(v=>v+1);}catch(e){setError(dataErrorKey(e));}finally{setBusy('');}}
 if(authMode==='demo')return <NotConnectedView/>;
 return <><ProdPageHeader titleKey="notificationsTitle" subKey="p5NotificationNotice"/>{error&&<div role="alert" className="notice danger">{t(error)}</div>}<section className="card card-pad"><button className="btn btn-outline" onClick={()=>setRevision(v=>v+1)}>{t('pbRefresh')}</button>{loading&&<p role="status">{t('p4Loading')}</p>}{!loading&&!rows.length&&<div className="no-data">{t('noResults')}</div>}{rows.map(n=><article className="request-row" key={n.id}><div><Link to={safeTarget(n.target)}>{t('p5N_'+n.kind)}</Link><p><time>{n.created_at}</time> · {t(n.read_at?'p5Read':'p5Unread')}</p></div>{!n.read_at&&<button className="btn btn-outline" disabled={!!busy} onClick={()=>void read(n.id)}>{t('p5MarkRead')}</button>}</article>)}</section></>;
}
