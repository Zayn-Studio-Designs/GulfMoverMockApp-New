import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useOnboarding } from '../context/OnboardingContext';
import { useAuth } from '../context/AuthContext';
import { ProdPageHeader, NotConnectedView, dataErrorKey } from '../components/ProductionUi';
import { listMembers, listInvitations, inviteMember, acceptInvitation, cancelInvitation, revokeMember, memberHistory, type Member, type Invitation, type MemberEvent } from '../lib/operationsService';

export default function CompanyMembersView() {
 const { t }=useLanguage(); const { authMode, user }=useAuth(); const { status,refresh }=useOnboarding();
 const companies=status.phase==='ready' && status.snapshot.profile?.status!=='suspended' ? status.snapshot.memberships.filter(m=>m.membershipRole==='company_admin' && m.membershipStatus==='active' && m.organization?.status==='approved'):[];
 const [org,setOrg]=useState(''); const selected=org || companies[0]?.organizationId || '';
 const [members,setMembers]=useState<Member[]>([]); const [invites,setInvites]=useState<Invitation[]>([]); const [events,setEvents]=useState<MemberEvent[]>([]);
 const [email,setEmail]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const [loading,setLoading]=useState(true); const [message,setMessage]=useState(''); const [revision,setRevision]=useState(0); const pending=useRef(false);
 useEffect(()=>{let alive=true;if(authMode!=='production')return;
 setLoading(true);setError('');setMembers([]);setInvites([]);setEvents([]);
 void Promise.all([listInvitations(),selected?listMembers(selected):Promise.resolve([]),selected?memberHistory(selected):Promise.resolve([])])
 .then(([i,m,e])=>{if(alive){setInvites(i);setMembers(m);setEvents(e);}}).catch(e=>{if(alive)setError(dataErrorKey(e));}).finally(()=>{if(alive)setLoading(false);});
 return()=>{alive=false;};},[selected,revision,authMode]);
 async function action(fn:()=>Promise<unknown>,key='p5Saved'){if(pending.current)return;pending.current=true;setBusy(true);setError('');setMessage('');
 try{await fn();setMessage(key);setRevision(v=>v+1);await refresh();}catch(e){setError(dataErrorKey(e));}finally{pending.current=false;setBusy(false);}}
 if(authMode==='demo')return <NotConnectedView/>;
 return <><ProdPageHeader titleKey="p5Members" subKey="p5InviteNotice"/>
 {error&&<div role="alert" className="notice danger">{t(error)}</div>}{message&&<div role="status" className="notice" style={{marginTop:12}}>{t(message)}</div>}
 {loading&&<p role="status">{t('p4Loading')}</p>}
 {companies.length>0&&<section className="card card-pad" aria-labelledby="members-current" style={{marginTop:12}}><div className="field" style={{maxWidth:360}}><label htmlFor="member-org">{t('organization')}</label><select id="member-org" value={selected} disabled={busy} onChange={e=>setOrg(e.target.value)}>{companies.map(c=><option key={c.organizationId} value={c.organizationId}>{c.organization?.legalName}</option>)}</select></div>
 <form className="grid" style={{marginTop:14}} onSubmit={(e:FormEvent)=>{e.preventDefault();void action(()=>inviteMember(selected,email),'p5InviteSaved');}}><div className="field" style={{maxWidth:360}}><label htmlFor="invite-email">{t('emailLabel')}</label><input id="invite-email" required type="email" autoComplete="email" dir="ltr" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></div><div><button className="btn btn-primary" disabled={busy}>{t('p5Invite')}</button></div></form>
 <h2 id="members-current" className="card-title" style={{marginTop:18}}>{t('p5Members')}</h2>{members.map(m=><div className="request-row" key={m.id}><div><div className="request-title">{m.display_name||m.email}</div><div className="request-meta" dir="auto">{m.email} · {t(m.membership_role==='company_admin'?'onbRoleAdmin':'onbRoleBooker')} · {t('p5_'+m.status)}</div></div>{m.membership_role==='company_booker'&&m.status!=='suspended'&&<button className="btn btn-outline" disabled={busy} onClick={()=>void action(()=>revokeMember(m.id))}>{t('p5Revoke')}</button>}</div>)}
 <h2 className="card-title" style={{marginTop:18}}>{t('p5History')}</h2>{events.map(e=><p key={e.id} className="small muted">{t('p5_'+e.action)} · <time>{e.occurred_at}</time></p>)}</section>}
 <section className="card card-pad" aria-labelledby="members-invites" style={{marginTop:16}}><h2 id="members-invites" className="card-title">{t('p5Invitations')}</h2><p className="card-desc">{t('p5InviteNotice')}</p>{!loading&&invites.length===0&&<div className="no-data">{t('noResults')}</div>}
 {invites.map(i=><article className="request-row" key={i.id}><div style={{overflowWrap:'anywhere'}}><strong>{i.email}</strong><p>{t('p5_'+i.status)} · {t('p5Expires')}: {i.expires_at}</p><p className="mono">{i.organization_id}</p></div><div className="row">
 {i.status==='pending'&&i.email===user?.email?.toLowerCase()&&<button className="btn btn-primary" disabled={busy} onClick={()=>void action(()=>acceptInvitation(i.id))}>{t('p5Accept')}</button>}
 {i.status==='pending'&&companies.some(c=>c.organizationId===i.organization_id)&&<button className="btn btn-outline" disabled={busy} onClick={()=>void action(()=>cancelInvitation(i.id))}>{t('cancel')}</button>}
 </div></article>)}</section></>;
}
