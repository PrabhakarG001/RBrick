import React,{useCallback,useEffect,useRef,useState} from 'react';
import { useSafety,apiRequest } from './SafetyContext';
import { when } from './safetyData';
const labelSource=value=>value==='simulation'?'Simulated data':value==='hardware'?'Hardware':value==='operator'?'Operator entry':'System';
const initialVisitor={name:'',company:'',purpose:'',simulation:true};

// Uses the existing Monitoring page, shared token/client, cards, tables and
// camera viewer. No alternate layout or public snapshot URLs.
export function SecurityPanel({CameraPanel,Table,Stat}){
  const safety=useSafety(),{token}=safety;
  const [tab,setTab]=useState('Cameras'),[data,setData]=useState(null),[rows,setRows]=useState({items:[],total:0}),[zones,setZones]=useState([]),[devices,setDevices]=useState([]);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  const [page,setPage]=useState(1),[search,setSearch]=useState(''),[status,setStatus]=useState(''),[zone,setZone]=useState(''),[severity,setSeverity]=useState(''),[sort,setSort]=useState('desc'),[eventType,setEventType]=useState('');
  const [source,setSource]=useState(''),[from,setFrom]=useState(''),[before,setBefore]=useState('');
  const [visitor,setVisitor]=useState(initialVisitor),[selected,setSelected]=useState(null),[details,setDetails]=useState(null),[ruleEdits,setRuleEdits]=useState({});
  const [resolution,setResolution]=useState(''),[editingVisitor,setEditingVisitor]=useState('');
  const [visitZone,setVisitZone]=useState('');
  const generation=useRef(0),controller=useRef(null);
  const request=useCallback((path,options)=>apiRequest(token,`/security${path}`,options),[token]);
  const refresh=useCallback(async()=>{
    if(!token)return;
    const revision=++generation.current;controller.current?.abort();const current=new AbortController();controller.current=current;
    setLoading(true);
    try{
      const query=new URLSearchParams({page:String(page),limit:'20',sort});
      for(const [key,value] of Object.entries({search,status,zoneId:zone,severity,source,type:eventType,from:from?new Date(from).toISOString():'',before:before?new Date(before).toISOString():''}))if(value)query.set(key,value);
      const path={Cameras:'/cameras',Motion:'/motion-events',Visitors:'/visitors',Events:'/events',Alerts:'/alerts',Rules:'/rules',Audit:'/audit-logs',Notifications:'/notifications'}[tab];
      const [overview,simulation,list,zoneList,deviceList]=await Promise.all([
        request('/overview',{signal:current.signal}),request('/simulation/status',{signal:current.signal}),request(`${path}?${query}`,{signal:current.signal}),
        request('/zones?limit=100',{signal:current.signal}),request(`/devices?limit=100${zone?'&zoneId='+encodeURIComponent(zone):''}`,{signal:current.signal}),
      ]);
      if(revision!==generation.current)return;
      setData({...overview,simulationEnabled:simulation.enabled});setRows(list);setZones(zoneList.items);setDevices(deviceList.items);setError('');
    }catch(e){if(revision===generation.current&&e.name!=='AbortError')setError(e.message);}
    finally{if(revision===generation.current)setLoading(false);}
  },[request,token,tab,page,search,status,zone,severity,source,sort,eventType,from,before]);
  useEffect(()=>{setData(null);setRows({items:[],total:0});setDetails(null);setSelected(null);setError('');},[token]);
  useEffect(()=>{refresh();const timer=setInterval(()=>{if(!document.hidden)refresh();},10000);return()=>{clearInterval(timer);generation.current++;controller.current?.abort();};},[refresh]);
  const act=async(path,body={},method='POST')=>{
    setBusy(true);setError('');setNotice('');
    try{const result=await request(path,{method,body});await refresh();await safety.refresh();setNotice('Saved to backend.');return result;}
    catch(e){setError(e.message);return null;}finally{setBusy(false);}
  };
  const selectTab=value=>{setTab(value);setPage(1);setStatus('');setSeverity('');setEventType('');setSearch('');setZone('');setSource('');setFrom('');setBefore('');setDetails(null);setSelected(null);};
  const change=setter=>event=>{setter(event.target.value);setPage(1);};
  const exportVisitors=async()=>{
    try{
      const query=new URLSearchParams({search,status,zoneId:zone,source,sort,...(from?{from:new Date(from).toISOString()}:{}),...(before?{before:new Date(before).toISOString()}: {})});
      for(const [key,value] of [...query])if(!value)query.delete(key);
      const base=import.meta.env.VITE_API_URL||'/api';
      const response=await fetch(`${base}/security/visitors/export?${query}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error((await response.json()).message||'Export failed');
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='security-visitors.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(e.message);}
  };
  if(!token)return <p className="db-subtitle">Connect using the existing IoT API connection form to load security data.</p>;
  const running=Boolean(data?.simulation?.running);
  const buttons=children=><div className="safety-controls">{children}</div>;
  const detail=async row=>{try{setSelected(row);if(tab==='Visitors')setDetails(await request(`/visitors/${row.visitorId}/visits?limit=100`));else setDetails(await request(`/events/${row._id}`));}catch(e){setError(e.message);}};
  const items=rows.items||[];
  return <section aria-label="Security and surveillance module">
    <h2 className="db-section-label">Security &amp; Surveillance</h2>
    <p className="db-subtitle" role="status">{running?'Simulation active - all demo motion and sample images are simulated.':'Simulation stopped. Hardware connection is not required.'} Updates poll every 10 seconds.</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{loading&&!data&&<p>Loading security data...</p>}
    {buttons(<><button className="db-tab" disabled={busy||!data?.simulationEnabled||running} onClick={()=>act('/simulation/start')}>Start simulation</button><button className="db-tab" disabled={busy||!running} onClick={()=>act('/simulation/stop')}>Stop simulation</button><button className="db-tab" disabled={loading} onClick={refresh}>Refresh security</button></>)}
    {data&&!data.simulationEnabled&&<p className="db-subtitle">Simulation is disabled by server configuration (SECURITY_SIMULATION_ENABLED).</p>}
    <div className="db-stats-grid safety-section">{[['Total cameras','totalCameras'],['Online cameras','onlineCameras'],['Offline cameras','offlineCameras'],['Motion events today (UTC)','motionToday'],['Active security alerts','activeAlerts'],['Visitors currently inside','visitorsInside']].map(([label,key])=><Stat key={key} label={label} value={data?.[key]}/>)}</div>
    {buttons(['Cameras','Motion','Visitors','Events','Alerts','Rules','Audit','Notifications'].map(name=><button className={`db-tab${tab===name?' db-tab--active':''}`} key={name} onClick={()=>selectTab(name)}>{name}{name==='Notifications'?` (${data?.unreadNotifications??0} unread)`:''}</button>))}
    {tab!=='Rules'&&<div className="safety-controls safety-section">
      <label>Search<input className="safety-input" value={search} onChange={change(setSearch)}/></label>
      <label>Zone<select className="safety-input" value={zone} onChange={change(setZone)}><option value="">All zones</option>{zones.map(z=><option key={z.zoneId} value={z.zoneId}>{z.name}</option>)}</select></label>
      <label>Source<select className="safety-input" value={source} onChange={change(setSource)}><option value="">All sources</option>{['simulation','hardware','operator','system'].map(x=><option key={x}>{x}</option>)}</select></label>
      <label>Sort<select className="safety-input" value={sort} onChange={change(setSort)}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
      {['Alerts','Visitors','Notifications'].includes(tab)&&<label>Status<select className="safety-input" value={status} onChange={change(setStatus)}><option value="">All</option>{(tab==='Alerts'?['active','acknowledged','resolved']:tab==='Visitors'?['inside','outside']:['unread','read']).map(x=><option key={x}>{x}</option>)}</select></label>}
      {['Alerts','Events','Motion'].includes(tab)&&<label>Severity<select className="safety-input" value={severity} onChange={change(setSeverity)}><option value="">All</option>{['info','warning','high','critical'].map(x=><option key={x}>{x}</option>)}</select></label>}
      {tab==='Events'&&<label>Event type<input className="safety-input" value={eventType} onChange={change(setEventType)} placeholder="motion_detected"/></label>}
      {['Events','Motion','Audit','Visitors'].includes(tab)&&<><label>From<input className="safety-input" type="datetime-local" value={from} onChange={change(setFrom)}/></label><label>Before<input className="safety-input" type="datetime-local" value={before} onChange={change(setBefore)}/></label></>}
    </div>}
    {tab==='Cameras'&&<><CameraPanel/><Table headers={['Camera','Connectivity','Source','Last seen','Latest successful snapshot']} rows={items.map(c=>[c.deviceId,c.state,labelSource(c.source),when(c.lastSeenAt),when(c.latestSnapshot?.capturedAt)])}/><p className="db-subtitle">Demo snapshots are bundled illustrations, never live video or physical captures.</p>{buttons(<><button className="db-tab" disabled={busy||!running} onClick={()=>act('/simulation/camera',{online:true})}>Simulate camera online</button><button className="db-tab" disabled={busy||!running} onClick={()=>act('/simulation/camera',{online:false})}>Simulate camera offline</button></>)}</>}
    {tab==='Motion'&&<>
      {buttons(<><button className="db-tab" disabled={busy||!running} onClick={()=>act('/simulation/motion',{active:true})}>Simulate motion</button><button className="db-tab" disabled={busy||!running} onClick={()=>act('/simulation/motion',{active:false})}>Clear simulated motion</button><button className="db-tab" disabled={busy||!running} onClick={()=>act('/simulation/access')}>Simulate unauthorized access</button></>)}
      <Table headers={['PIR device','Zone','Motion state','Last detection','Connectivity','Source']} rows={devices.filter(d=>d.securityType==='pir').map(d=>[d.deviceId,d.zoneId,d.motionActive===true?'Motion detected':d.motionActive===false?'Cleared':'Unknown',when(d.lastMotionAt),d.lastSeenAt?Date.now()-Date.parse(d.lastSeenAt)>(safety.meta?.offlineAfterSeconds||120)*1000||d.online===false?'Offline':'Online':'Unknown',labelSource(d.securitySource)])}/>
    </>}
    {tab==='Visitors'&&<>
      <form className="safety-controls safety-section" onSubmit={async e=>{e.preventDefault();const result=await act(editingVisitor?`/visitors/${editingVisitor}`:'/visitors',editingVisitor?{name:visitor.name,company:visitor.company,purpose:visitor.purpose}:visitor,editingVisitor?'PATCH':'POST');if(result){setVisitor(initialVisitor);setEditingVisitor('');}}}>
        {['name','company','purpose'].map(key=><label key={key}>Visitor {key}<input className="safety-input" required={key==='name'} maxLength={key==='purpose'?300:100} value={visitor[key]} onChange={e=>setVisitor({...visitor,[key]:e.target.value})}/></label>)}
        {!editingVisitor&&<label><input type="checkbox" checked={visitor.simulation} onChange={e=>setVisitor({...visitor,simulation:e.target.checked})}/>Demo visitor (simulated)</label>}
        <button className="db-tab" disabled={busy}>{editingVisitor?'Save visitor':'Register visitor'}</button>{editingVisitor&&<button type="button" className="db-tab" onClick={()=>{setEditingVisitor('');setVisitor(initialVisitor);}}>Cancel edit</button>}
      </form>
      {buttons(<button className="db-tab" onClick={exportVisitors}>Export visitors CSV</button>)}
      <p className="db-subtitle">Registration does not check a visitor in. Check-in timestamps are generated by the server.</p>
      <label>Check-in zone<select className="safety-input" value={visitZone} onChange={e=>setVisitZone(e.target.value)}><option value="">Choose zone</option>{zones.map(z=><option key={z.zoneId} value={z.zoneId}>{z.name}</option>)}</select></label>
      <Table headers={['Visitor','Company / purpose','Status','Source','Actions']} rows={items.map(v=>[`${v.name} (${v.visitorId})`,`${v.company} / ${v.purpose}`,v.activeVisits?.length?'Inside':'Outside',labelSource(v.source),buttons(<React.Fragment key={v.visitorId}><button className="db-tab" disabled={busy||Boolean(v.activeVisits?.length)||!visitZone} onClick={()=>act(`/visitors/${v.visitorId}/check-in`,{zoneId:visitZone})}>Check in</button><button className="db-tab" disabled={busy||!v.activeVisits?.length} onClick={()=>act(`/visitors/${v.visitorId}/check-out`)}>Check out</button><button className="db-tab" onClick={()=>detail(v)}>Visit history</button><button className="db-tab" onClick={()=>{setEditingVisitor(v.visitorId);setVisitor({name:v.name,company:v.company,purpose:v.purpose,simulation:v.source==='simulation'});}}>Edit visitor</button></React.Fragment>)])}/>
      {selected&&details&&<section className="db-chart-card safety-section"><h3>Visit history - {selected.name}</h3><Table headers={['Zone','Checked in','Checked out','Source']} rows={(details.items||[]).map(v=>[v.zoneId,when(v.checkedInAt),when(v.checkedOutAt),labelSource(v.source)])}/></section>}
    </>}
    {['Events','Motion','Audit'].includes(tab)&&<Table headers={['Event','Description','Zone / reference','Time','Source','Details']} rows={items.map(row=>[row.type||row.action,row.description,row.zoneId||row.reference,when(row.occurredAt),labelSource(row.source),tab==='Audit'?row.actor:<button className="db-tab" onClick={()=>detail(row)}>Event details</button>])}/>}
    {['Events','Motion'].includes(tab)&&selected&&details&&<section className="db-chart-card safety-section"><h3>Security event details</h3><p className="db-subtitle">{details.item?.eventId} - {details.item?.deviceId||'No device'} - {details.item?.severity} - {labelSource(details.item?.source)}</p><p className="db-subtitle">{details.item?.description} - Observed {when(details.item?.occurredAt)} - Received {when(details.item?.receivedAt)}</p></section>}
    {tab==='Alerts'&&<><label>Resolution note<input className="safety-input" value={resolution} maxLength={1000} onChange={e=>setResolution(e.target.value)}/></label><Table headers={['Alert','Severity','Zone','Source','State','Actions']} rows={items.map(a=>[a.message,a.severity,a.zoneId,labelSource(a.source),a.resolvedAt?'Resolved':a.acknowledgedAt?'Acknowledged':'Active',buttons(<React.Fragment key={a._id}><button className="db-tab" disabled={busy||Boolean(a.acknowledgedAt)||Boolean(a.resolvedAt)} onClick={()=>act(`/alerts/${a._id}/acknowledge`)}>Acknowledge alert</button><button className="db-tab" disabled={busy||!a.acknowledgedAt||Boolean(a.resolvedAt)} onClick={()=>act(`/alerts/${a._id}/resolve`,{resolution})}>Resolve alert</button></React.Fragment>)])}/></>}
    {tab==='Notifications'&&<Table headers={['Notification','Source','Created','Read','Action']} rows={items.map(n=>[n.message,labelSource(n.source),when(n.createdAt),when(n.readAt),<button className="db-tab" disabled={busy||Boolean(n.readAt)} onClick={()=>act(`/notifications/${n._id}/read`)}>Mark read</button>])}/>}
    {tab==='Rules'&&<><p className="db-subtitle">Operating hours use each zone's configured time zone. Minutes are 0-1439; equal start/end means all day on selected weekdays (0 Sunday to 6 Saturday).</p>{items.map(rule=>{
      const edit={...rule,...ruleEdits[rule.key]},set=(key,value)=>setRuleEdits(prev=>({...prev,[rule.key]:{...prev[rule.key],[key]:value}}));
      return <form key={rule.key} className="db-chart-card safety-section" onSubmit={async e=>{e.preventDefault();if(await act(`/rules/${rule.key}`,ruleEdits[rule.key]||{enabled:rule.enabled},'PATCH'))setRuleEdits(prev=>({...prev,[rule.key]:{}}));}}><h3 className="db-card-title">{rule.key}</h3><div className="safety-controls"><label><input type="checkbox" checked={edit.enabled} onChange={e=>set('enabled',e.target.checked)}/>Enabled</label><label>Rule severity<select className="safety-input" value={edit.severity} onChange={e=>set('severity',e.target.value)}>{['warning','high','critical'].map(x=><option key={x}>{x}</option>)}</select></label>
        {(rule.key==='off_hours'?['startMinute','endMinute']:rule.key==='repeated_motion'?['threshold','windowSeconds']:rule.key==='camera_offline'?['timeoutSeconds']:[]).map(key=><label key={key}>{key}<input className="safety-input" type="number" value={edit[key]} min={0} max={key.includes('Minute')?1439:86400} onChange={e=>set(key,Number(e.target.value))}/></label>)}
        {rule.key==='off_hours'&&<label>Weekdays<input className="safety-input" value={edit.days.join(',')} onChange={e=>set('days',e.target.value.split(',').map(Number))}/></label>}
        <button className="db-tab" disabled={busy}>Save rule</button></div></form>;
    })}</>}
    {tab!=='Rules'&&buttons(<><span className="db-subtitle">{rows.total??0} records - Page {page}</span><button className="db-tab" disabled={page===1} onClick={()=>setPage(page-1)}>Previous records</button><button className="db-tab" disabled={page*20>=(rows.total||0)} onClick={()=>setPage(page+1)}>Next records</button></>)}
  </section>;
}
