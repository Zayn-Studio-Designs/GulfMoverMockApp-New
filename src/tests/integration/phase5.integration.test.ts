// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { confirmedUser, grantPlatformRole, localStackConfigured, quote, sql, type TestUser } from './helpers';
const suite=localStackConfigured?describe:describe.skip;
suite('Phase 5 real local database',()=>{
 let admin:TestUser,other:TestUser,recipient:TestUser,staff:TestUser;let org:string,org2:string,inv:string,member:string;
 beforeAll(async()=>{
  admin=await confirmedUser('p5-admin');other=await confirmedUser('p5-other');recipient=await confirmedUser('p5-recipient');staff=await confirmedUser('p5-review');grantPlatformRole(staff.id,'super_admin');
  async function company(u:TestUser){const r=await u.client.rpc('register_company',{p_registration_key:randomUUID(),p_legal_name:'Fiction '+randomUUID(),p_profile_display_name:'Fictional Admin'});expect(r.error).toBeNull();const id=r.data[0].id;expect((await staff.client.rpc('review_company',{p_organization_id:id,p_decision:'approve'})).error).toBeNull();return id;}
  org=await company(admin);org2=await company(other);
 },60000);
 it('only own-company administrators invite; cannot supply a role or bypass consent with direct writes',async()=>{
  expect((await other.client.rpc('invite_company_member',{p_org:org,p_email:recipient.email})).error?.code).toBe('42501');
  expect((await admin.client.from('organization_memberships').insert({organization_id:org,user_id:recipient.id,membership_role:'company_booker',status:'active',invited_by:admin.id})).error).not.toBeNull();
  expect((await recipient.client.rpc('list_company_members',{p_org:org})).error?.code).toBe('42501');
  expect((await admin.client.rpc('list_company_members',{p_org:org2})).error?.code).toBe('42501');
 });
 it('concurrent invitation retries converge with one audit event and confirmed email binding',async()=>{
  const results=await Promise.all(Array.from({length:4},()=>admin.client.rpc('invite_company_member',{p_org:org,p_email:recipient.email.toUpperCase()})));
  expect(results.every(r=>!r.error)).toBe(true);inv=results[0].data;expect(new Set(results.map(r=>r.data)).size).toBe(1);
  expect(sql(`select count(*) from public.membership_events where invitation_id=${quote(inv)} and action='invited'`)).toBe('1');
  expect((await other.client.rpc('accept_company_invitation',{p_id:inv})).error?.code).toBe('42501');
  const r=await recipient.client.rpc('accept_company_invitation',{p_id:inv});expect(r.error).toBeNull();
  expect((await recipient.client.rpc('accept_company_invitation',{p_id:inv})).data).toBe('unchanged');
  const list=await admin.client.rpc('list_company_members',{p_org:org});expect(list.error).toBeNull();
  member=list.data.find((m:{email:string})=>m.email===recipient.email).id;
  expect(sql(`select membership_role from public.organization_memberships where id=${quote(member)}`)).toBe('company_booker');
 });
 it('revocation is scoped, audited once, removes access and cannot revoke admins',async()=>{
  expect((await other.client.rpc('revoke_company_member',{p_id:member})).error?.code).toBe('42501');
  expect((await admin.client.rpc('revoke_company_member',{p_id:member})).data).toBe('recorded');
  expect((await admin.client.rpc('revoke_company_member',{p_id:member})).data).toBe('unchanged');
  expect((await recipient.client.rpc('has_org_role',{p_org:org,p_roles:['company_booker']})).data).toBe(false);
  expect(sql(`select count(*) from public.membership_events where member_id=${quote(member)} and action='membership_revoked'`)).toBe('1');
  const a=sql(`select id from public.organization_memberships where user_id=${quote(admin.id)} and organization_id=${quote(org)}`);
  expect((await admin.client.rpc('revoke_company_member',{p_id:a})).error?.code).toBe('42501');
 });
 it('cancelled and expired invitations refuse acceptance; recipients cannot cancel and unrelated invitations remain private',async()=>{
  const r=await admin.client.rpc('invite_company_member',{p_org:org,p_email:recipient.email});expect(r.error).toBeNull();
  expect((await recipient.client.rpc('cancel_company_invitation',{p_id:r.data})).error?.code).toBe('42501');
  expect((await admin.client.rpc('cancel_company_invitation',{p_id:r.data})).data).toBe('recorded');
  expect((await recipient.client.rpc('accept_company_invitation',{p_id:r.data})).error?.code).toBe('55000');
  const expired=await admin.client.rpc('invite_company_member',{p_org:org,p_email:recipient.email});
  sql(`update public.company_invitations set expires_at=now()-interval '1 second' where id=${quote(expired.data)}`);
  expect((await recipient.client.rpc('accept_company_invitation',{p_id:expired.data})).error?.code).toBe('55000');
  expect((await other.client.from('company_invitations').select('id').eq('organization_id',org)).data).toEqual([]);
 });
 for(const kind of ['materials','charter']){
 it(`${kind} persists with retry safety, boundaries, validated review and private audit`,async()=>{
  const key=randomUUID(),details={description:'Fictional request',destination:'Proposed destination',date:'2027-01-12'};
  const args={p_org:org,p_kind:kind,p_key:key,p_details:details};
  const responses=await Promise.all(Array.from({length:3},()=>admin.client.rpc('submit_transfer_request',args)));
  expect(responses.every(r=>!r.error)).toBe(true);const id=responses[0].data;expect(new Set(responses.map(r=>r.data)).size).toBe(1);
  expect((await admin.client.rpc('submit_transfer_request',{...args,p_details:{description:'changed'}})).error?.message).toMatch(/^payload_mismatch/);
  expect((await other.client.rpc('submit_transfer_request',{...args,p_key:randomUUID()})).error?.code).toBe('42501');
  expect((await recipient.client.rpc('submit_transfer_request',{...args,p_key:randomUUID()})).error?.code).toBe('42501');
  expect((await other.client.from('transfer_requests').select('id').eq('id',id)).data).toEqual([]);
  expect((await other.client.from('transfer_request_events').select('id').eq('request_id',id)).data).toEqual([]);
  expect((await admin.client.rpc('review_transfer_request',{p_id:id,p_revision:0,p_status:'reviewed_for_planning',p_reason:'Reviewed'})).error?.code).toBe('42501');
  const review={p_id:id,p_revision:0,p_status:'reviewed_for_planning',p_reason:'Internal planning only'};
  const decisions=await Promise.all(Array.from({length:3},()=>staff.client.rpc('review_transfer_request',review)));
  expect(decisions.every(r=>!r.error)).toBe(true);expect(decisions.filter(r=>r.data==='recorded')).toHaveLength(1);
  expect(sql(`select count(*) from public.transfer_request_events where request_id=${quote(id)}`)).toBe('2');
  expect((await staff.client.rpc('review_transfer_request',{...review,p_revision:1,p_status:'rejected'})).error?.code).toBe('55000');
  expect((await admin.client.from('transfer_requests').update({status:'reviewed_for_planning'}).eq('id',id)).error).not.toBeNull();
  const row=await admin.client.from('transfer_requests').select('reference,status,details').eq('id',id).single();expect(row.error).toBeNull();expect(row.data?.reference).toMatch(/^RQ-/);expect(row.data?.details).toEqual(details);
 });}
 it('validates request fields and denies suspended staff review with an existing JWT',async()=>{
  for(const details of [{description:' '},{description:'ok',invented:'value'},{description:'ok',passengers:'-1'},{description:'ok',date:'2027-02-30'}])expect((await admin.client.rpc('submit_transfer_request',{p_org:org,p_kind:'charter',p_key:randomUUID(),p_details:details})).error).not.toBeNull();
  const r=await admin.client.rpc('submit_transfer_request',{p_org:org,p_kind:'materials',p_key:randomUUID(),p_details:{description:'Testing suspension'}});
  sql(`update public.profiles set status='suspended' where id=${quote(staff.id)}`);
  expect((await staff.client.rpc('review_transfer_request',{p_id:r.data,p_revision:0,p_status:'rejected',p_reason:'test'})).error?.code).toBe('42501');
  expect((await staff.client.from('transfer_requests').select('id')).data).toEqual([]);
  sql(`update public.profiles set status='active' where id=${quote(staff.id)}`);
 });
 it('an invitation cannot be accepted after its inviter loses administrative authority',async()=>{
  const fresh=await confirmedUser('stale-invite');const r=await admin.client.rpc('invite_company_member',{p_org:org,p_email:fresh.email});expect(r.error).toBeNull();
  sql(`update public.organization_memberships set status='suspended' where user_id=${quote(admin.id)} and organization_id=${quote(org)}`);
  expect((await fresh.client.rpc('accept_company_invitation',{p_id:r.data})).error?.code).toBe('42501');
  expect(sql(`select count(*) from public.organization_memberships where user_id=${quote(fresh.id)} and organization_id=${quote(org)}`)).toBe('0');
  sql(`update public.organization_memberships set status='active' where user_id=${quote(admin.id)} and organization_id=${quote(org)}`);
 });
 it('notifications are owner-only, generated once per event and mark-read cannot alter another user',async()=>{
  const mine=await admin.client.from('notifications').select('id,kind,read_at');expect(mine.error).toBeNull();expect(mine.data!.length).toBeGreaterThan(0);
  expect(mine.data!.some(n=>n.kind==='company_decision')).toBe(true);expect(mine.data!.some(n=>n.kind==='request_reviewed_for_planning')).toBe(true);
  const id=mine.data![0].id;
  expect((await other.client.from('notifications').select('id').eq('id',id)).data).toEqual([]);
  expect((await other.client.rpc('mark_notification_read',{p_id:id})).data).toBe(false);
  expect((await admin.client.rpc('mark_notification_read',{p_id:id})).data).toBe(true);
  expect((await admin.client.rpc('mark_notification_read',{p_id:id})).data).toBe(true);
  expect((await admin.client.from('notifications').update({kind:'forged'}).eq('id',id)).error).not.toBeNull();
  expect(sql(`select count(*) from (select user_id,event_key from public.notifications group by user_id,event_key having count(*)>1) d`)).toBe('0');
  expect(sql(`select count(*) from public.notifications where user_id=${quote(recipient.id)} and kind='membership_membership_revoked'`)).toBe('1');
 });
});
