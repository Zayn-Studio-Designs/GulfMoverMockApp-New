import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding, usePlatformRoles } from '../context/OnboardingContext';
import { ProdPageHeader, NotConnectedView, RequireRoles, dataErrorKey } from '../components/ProductionUi';
import { bookableOrganizations } from '../lib/companyService';
import { newRequestKey } from '../lib/dataService';
import { listTransfers, submitTransfer, transferHistory, reviewTransfer, type TransferKind, type TransferRequest, type TransferEvent } from '../lib/operationsService';

const fields:Record<TransferKind,string[]>={materials:['description','destination','date','quantity','weight','dimensions','sender','receiver','notes'],charter:['description','destination','date','time','passengers','duration','materials','notes']};
export default function TransferRequestsView({kind,admin=false}:{kind:TransferKind;admin?:boolean}){
 const {authMode}=useAuth();
 if(authMode==='demo')return <NotConnectedView/>;
 return admin?<RequireRoles roles={['super_admin','operations']}><Requests kind={kind} admin/></RequireRoles>:<Requests kind={kind}/>;
}
function Requests({kind,admin=false}:{kind:TransferKind;admin?:boolean}){
 const {t}=useLanguage();const {user}=useAuth();const {status}=useOnboarding();const roles=usePlatformRoles();
 const companies=status.phase==='ready'&&status.snapshot.profile?.status!=='suspended'?bookableOrganizations(status.snapshot):[];
 const [org,setOrg]=useState('');const [details,setDetails]=useState<Record<string,string>>({});const [requests,setRequests]=useState<TransferRequest[]>([]);
 const [selected,setSelected]=useState('');const [events,setEvents]=useState<TransferEvent[]>([]);const [reason,setReason]=useState('');const [decision,setDecision]=useState('clarification_required');
 const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(true);const [revision,setRevision]=useState(0);const inFlight=useRef(false);
 const keyStorage=`gm-transfer-attempt:${user?.id}:${kind}`;
 function attempt(){let key=sessionStorage.getItem(keyStorage);if(!key){key=newRequestKey();sessionStorage.setItem(keyStorage,key);}return key;}
 useEffect(()=>{let alive=true;setLoading(true);setError('');setRequests([]);setSelected('');
 void listTransfers(kind).then(data=>{if(alive)setRequests(data);}).catch(e=>{if(alive)setError(dataErrorKey(e));}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[kind,revision]);
 useEffect(()=>{let alive=true;setEvents([]);if(selected)void transferHistory(selected).then(data=>{if(alive)setEvents(data);}).catch(e=>{if(alive)setError(dataErrorKey(e));});return()=>{alive=false;};},[selected,revision]);
 const current=requests.find(r=>r.id===selected);
 async function action(e:FormEvent,fn:()=>Promise<unknown>){e.preventDefault();if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');setMessage('');try{await fn();setMessage('p5Saved');setRevision(v=>v+1);}catch(e){setError(dataErrorKey(e));}finally{setBusy(false);inFlight.current=false;}}
 return <><ProdPageHeader titleKey={kind==='materials'?'p5Materials':'p5Charter'} subKey="p5RequestNotice"/>
 {error&&<p role="alert" className="notice danger">{t(error)}</p>}{message&&<p role="status">{t(message)}</p>}
 {!admin&&companies.length>0&&<section className="card card-pad"><form onSubmit={e=>void action(e,async()=>{await submitTransfer(org||companies[0].id,kind,attempt(),details);sessionStorage.removeItem(keyStorage);setDetails({});})}>
 <fieldset disabled={busy} style={{minWidth:0,border:0,padding:0}}><div className="form-grid"><div className="field"><label htmlFor="request-company">{t('organization')}</label><select id="request-company" value={org||companies[0].id} onChange={e=>setOrg(e.target.value)}>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
 {fields[kind].map(f=><div className="field" key={f}><label htmlFor={`request-${f}`}>{t('p5Field_'+f)}{f==='description'?' *':''}</label><input id={`request-${f}`} required={f==='description'} type={f==='date'?'date':f==='time'?'time':'text'} maxLength={1000} value={details[f]||''} onChange={e=>setDetails(d=>({...d,[f]:e.target.value}))}/></div>)}</div>
 <button type="submit" className="btn btn-primary">{t('p5SubmitRequest')}</button></fieldset></form></section>}
 {!admin&&companies.length===0&&!roles?.length&&<p className="notice warn">{t('pbNotEligibleBody')}</p>}
 <section className="card card-pad" style={{marginTop:16}}><div className="between"><h2>{t('p5History')}</h2><button className="btn btn-outline" disabled={busy} onClick={()=>setRevision(v=>v+1)}>{t('pbRefresh')}</button></div>
 {loading&&<p role="status">{t('p4Loading')}</p>}{!loading&&requests.length===0&&<p>{t('noResults')}</p>}
 {requests.map(r=><button type="button" key={r.id} className="request-row" style={{width:'100%',textAlign:'start',overflowWrap:'anywhere'}} onClick={()=>{setSelected(r.id);setReason('');}}><span className="mono">{r.reference}</span><span>{t('p5_'+r.status)}</span></button>)}</section>
 {current&&<section className="card card-pad" style={{marginTop:16}}><h2 className="mono">{current.reference}</h2><p>{t('p5_'+current.status)}</p><p className="notice warn">{t('p5RequestNotice')}</p>
 {Object.entries(current.details).map(([k,v])=><p key={k} style={{overflowWrap:'anywhere'}}><strong>{t('p5Field_'+k)}: </strong>{v}</p>)}
 {admin&&['pending_review','clarification_required'].includes(current.status)&&<form onSubmit={e=>void action(e,()=>reviewTransfer(current,decision,reason))}><fieldset disabled={busy} style={{minWidth:0,border:0,padding:0}}><label htmlFor="request-decision">{t('p5ReviewDecision')}</label><select id="request-decision" value={decision} onChange={e=>setDecision(e.target.value)}>{['clarification_required','reviewed_for_planning','rejected'].map(s=><option key={s} value={s}>{t('p5_'+s)}</option>)}</select><label htmlFor="request-reason">{t('reasonLabel')}</label><textarea id="request-reason" required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/><button className="btn btn-primary" disabled={!reason.trim()}>{t('p5Review')}</button></fieldset></form>}
 <h3>{t('p5History')}</h3>{events.map(e=><p key={e.id} style={{overflowWrap:'anywhere'}}>{t('p5_'+e.status)} · {e.reason} · {e.created_at}</p>)}</section>}</>;
}
