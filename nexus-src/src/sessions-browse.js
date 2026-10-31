// -- Sessions browser (F13): pure grouping, filters and bulk entry for the saved-sessions sheet. No React here. --
// Depends on session.js (normalizeVenue, venueLine, venueOptions, venueText, normalizeLabel, savedSessionMode,
// computeMetrics) and engine.js (formatElapsed), and on constants.js (getWheelNumbers). Times are local, as the app shows them.

const DAY_MS=86400000;
const ALL_FILTERS={casino:null,place:null,dealer:null,period:'all'};

// Local midnight of the day that holds ts.
function localDayStart(ts){const d=new Date(ts);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();}

// Monday 00:00 local of the week that holds now. "This week" starts here.
function thisWeekStart(now){
  const d=new Date(now);
  return new Date(d.getFullYear(),d.getMonth(),d.getDate()-((d.getDay()+6)%7)).getTime();
}

// When a session started: its start, or its creation for a session that was never started.
function sessionStartOf(sess){
  const started=Number(sess.sessionStartedAt);
  return started>0?started:(Number(sess.created)||0);
}

function dayLabel(dayStart,nowDayStart){
  const days=Math.round((nowDayStart-dayStart)/DAY_MS);
  if(days===0)return 'Today';
  if(days===1)return 'Yesterday';
  return new Date(dayStart).toLocaleDateString();
}

// Sessions newest first, grouped by the local day they started on: [{key, label, sessions}]. Ties keep id order.
function dayGroups(sessions,now){
  const sorted=(sessions||[]).filter(s=>!!s&&typeof s==='object')
    .slice()
    .sort((a,b)=>sessionStartOf(b)-sessionStartOf(a)||String(a.id).localeCompare(String(b.id)));
  const nowDay=localDayStart(now);
  const groups=[];
  sorted.forEach(s=>{
    const day=localDayStart(sessionStartOf(s));
    const last=groups[groups.length-1];
    if(last&&last.key===String(day))last.sessions.push(s);
    else groups.push({key:String(day),label:dayLabel(day,nowDay),sessions:[s]});
  });
  return groups;
}

// The place a venue names for the machine or table filter: a machine's make, model and version, or a table's label.
// Null when the venue names neither.
function placeLabel(venueInput){
  const v=normalizeVenue(venueInput);
  if(!v)return null;
  if(v.kind==='machine'){
    const parts=[v.maker,v.model,v.version].filter(Boolean);
    return parts.length?parts.join(' '):null;
  }
  if(v.kind==='table')return v.table||null;
  return null;
}

// Every dealer a session has had: the dealers recorded during it and the dealer on its venue.
function sessionDealers(sess){
  const out=[];
  (sess.dealerChanges||[]).forEach(e=>{const d=venueText(e&&e.dealer);if(d)out.push(d);});
  const v=normalizeVenue(sess.venue);
  if(v&&v.dealer)out.push(v.dealer);
  return out;
}

// The values each filter offers, drawn from the sessions it applies to, so a choice list holds only values that exist.
// Casino and dealer use the value lists F11 derives (venueOptions). Machine or table lists the places the sessions name.
function filterOptions(sessions){
  const list=(sessions||[]).filter(s=>!!s&&typeof s==='object');
  const places={};
  list.forEach(s=>{
    const p=placeLabel(s.venue);
    if(p&&!places[p.toLowerCase()])places[p.toLowerCase()]=p;
  });
  return {
    casino:venueOptions('casino',list),
    place:Object.keys(places).map(k=>places[k]).sort((a,b)=>a.localeCompare(b)),
    dealer:venueOptions('dealer',list),
  };
}

// Whether one session passes the filters. A filter that is null (or 'all' for the period) passes every session.
function sessionMatches(sess,filters,now){
  const f=filters||ALL_FILTERS;
  const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
  const v=normalizeVenue(sess.venue);
  if(f.casino&&!(v&&v.casino&&same(v.casino,f.casino)))return false;
  const place=placeLabel(sess.venue);
  if(f.place&&!(place&&same(place,f.place)))return false;
  if(f.dealer&&!sessionDealers(sess).some(d=>same(d,f.dealer)))return false;
  if(f.period==='week'&&sessionStartOf(sess)<thisWeekStart(now))return false;
  return true;
}

function filterSessions(sessions,filters,now){
  return (sessions||[]).filter(s=>!!s&&typeof s==='object'&&sessionMatches(s,filters,now));
}

// The facts one row shows. A session that was never started shows no duration. Otherwise the duration runs to the
// end, or to the last change while the session is still open.
function sessionRow(sess){
  const start=sessionStartOf(sess);
  const started=Number(sess.sessionStartedAt)>0;
  const end=Number(sess.sessionEndedAt)||Number(sess.modified)||start;
  const withTracks=Array.isArray(sess.tracks)?sess:Object.assign({},sess,{tracks:[]});
  return {
    id:sess.id,
    title:normalizeLabel(sess.label)||sess.name||'Session',
    venue:venueLine(sess.venue)||'No venue',
    hasVenue:!!venueLine(sess.venue),
    mode:savedSessionMode(sess),
    startTime:new Date(start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),
    duration:started?formatElapsed(Math.max(0,end-start)):'—',
    spins:Array.isArray(sess.spins)?sess.spins.length:0,
    pnl:computeMetrics(withTracks).netPnL,
  };
}

// What a resume from the sheet does first: 'confirm' when the current session has unsaved spins (the sheet asks in the
// shared Modal), 'resume' otherwise, and 'none' when the target is the current session already.
function resumeStep(sess,savedList,targetId){
  if(!sess||sess.id===targetId)return 'none';
  return unsavedSpinCount(sess,savedList)>0?'confirm':'resume';
}

// Parses a bulk entry: numbers separated by spaces or commas, oldest first. Every token must be a number on the wheel
// ("00" only on American). One bad token rejects the whole entry and is named. Repeats are kept: "2 2 2" is three spins.
// Returns {ok:true, numbers} | {ok:false, empty:true} | {ok:false, bad, message}.
function parseBulkNumbers(text,wheel,max){
  const tokens=String(text==null?'':text).split(/[\s,]+/).filter(Boolean);
  if(!tokens.length)return {ok:false,empty:true,message:''};
  const legal=getWheelNumbers(wheel);
  const bad=tokens.find(t=>legal.indexOf(t)<0);
  if(bad!==undefined){
    return {ok:false,bad,message:'"'+bad+'" is not a number on the '+(wheel==='american'?'American':'European')+' wheel.'};
  }
  if(tokens.length>max)return {ok:false,message:'Enter at most '+max+' numbers at a time.'};
  return {ok:true,numbers:tokens};
}
