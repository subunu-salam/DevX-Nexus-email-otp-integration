/*
   DEVX NEXUS — AI-PERSONALIZED SHOPPING GOALS + STREAKS
   Rules-first v1. No random challenges and no LLM-generated goal copy.
*/
const MIN_ORDERS = Math.max(1, parseInt(process.env.GOAL_MIN_ORDERS || '3', 10));
const MIN_HISTORY_DAYS = Math.max(0, parseInt(process.env.GOAL_MIN_HISTORY_DAYS || '14', 10));
const DAY_MS = 86400000;

const COMPLETED = new Set(['done','delivered','collected','completed']);
const COMPLEMENT_MAP = {
  'basmati rice':['chicken','garam masala','yogurt','tomato'],
  'rice':['chicken','garam masala','yogurt','tomato'],
  'chicken':['basmati rice','rice','garam masala','yogurt'],
  'eggs':['bread','arabic bread','milk'],
  'milk':['bread','eggs','cereal'],
  'bread':['eggs','milk','butter'],
  'butter':['bread','eggs'],
  'pasta':['tomato','olive oil'],
  'olive oil':['pasta','tomato'],
  'yogurt':['chicken','cucumber'],
  'onions':['tomato','potatoes'],
  'tomatoes':['onions','cucumber','olive oil'],
  'potatoes':['onions','chicken'],
  'chips':["pepsi cola",'mineral water'],
  'pepsi cola':['chips','mixed nuts'],
  'detergent':['fabric softener'],
};

function norm(s){return String(s||'').trim().toLowerCase()}
function dateOf(x){const d=new Date(x);return Number.isFinite(d.getTime())?d:null}
function completedOrders(orders, phone){
  const p=norm(phone).replace(/\D/g,'');
  return (orders||[]).filter(o=>COMPLETED.has(norm(o.status)) && !o.seed && (!p || norm((o.customer||{}).phone).replace(/\D/g,'').endsWith(p)));
}
function historyDays(orders, now=new Date()){
  const ds=orders.map(o=>dateOf(o.date)).filter(Boolean);
  if(!ds.length)return 0;
  const first=Math.min(...ds.map(d=>d.getTime()));
  return Math.max(0,Math.floor((now.getTime()-first)/DAY_MS));
}
function itemCounts(orders){
  const m=new Map();
  for(const o of orders){for(const it of (o.items||[])){const k=norm(it.name);if(!k)continue;m.set(k,(m.get(k)||0)+(it.loose?1:(Number(it.qty)||1)));}}
  return m;
}
function categoryCadence(orders){
  const by=new Map();
  for(const o of orders){const dt=dateOf(o.date);if(!dt)continue;for(const it of (o.items||[])){const cat=norm(it.cat||it.category||'');if(!cat)continue;if(!by.has(cat))by.set(cat,[]);by.get(cat).push(dt.getTime());}}
  const out=[];
  for(const [cat,dates] of by){dates.sort((a,b)=>a-b);if(dates.length<2)continue;const gaps=[];for(let i=1;i<dates.length;i++)gaps.push((dates[i]-dates[i-1])/DAY_MS);const avg=gaps.reduce((a,b)=>a+b,0)/gaps.length;const last=dates[dates.length-1];out.push({cat,avgDays:avg,lastDate:new Date(last),dueDays:Math.max(0,(Date.now()-last)/DAY_MS)});}
  return out.sort((a,b)=>b.dueDays-a.dueDays);
}
function searchSignals(queries, orders, catalog, phone){
  const p=norm(phone).replace(/\D/g,'');
  const mine=(queries||[]).filter(q=>!q.seed && (!p || norm(q.phone).replace(/\D/g,'').endsWith(p)));
  const bought=new Set();
  for(const o of orders){for(const it of (o.items||[]))bought.add(norm(it.name));}
  const grouped=new Map();
  for(const q of mine){const text=norm(q.query);if(text.length<3)continue;const matches=(catalog||[]).filter(x=>norm(x.name).includes(text)||norm(x.cat).includes(text)).map(x=>norm(x.name));const hit=matches.some(n=>bought.has(n));if(hit)continue;const key=text;const g=grouped.get(key)||{query:text,count:0,lastAt:q.at,resultCount:q.resultCount||matches.length};g.count++;if(new Date(q.at)>new Date(g.lastAt))g.lastAt=q.at;grouped.set(key,g)}
  return [...grouped.values()].sort((a,b)=>b.count-a.count||new Date(b.lastAt)-new Date(a.lastAt));
}
function chooseComplement(counts,catalog){
  const top=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
  const names=new Set((catalog||[]).map(p=>norm(p.name)));
  const bought=new Set(counts.keys());
  for(const [item,count] of top){
    const keys=Object.keys(COMPLEMENT_MAP).filter(k=>item.includes(k));
    for(const key of keys){for(const comp of COMPLEMENT_MAP[key]||[]){const found=[...names].find(n=>n.includes(comp));if(found && !bought.has(found))return {item,comp:found,count};}}
  }
  return null;
}
function goalFor({orders,queries,catalog,phone,now=new Date(),dismissed=[]}){
  const mine=completedOrders(orders,phone);
  const hDays=historyDays(mine,now);
  const base={eligible:mine.length>=MIN_ORDERS&&hDays>=MIN_HISTORY_DAYS,orderCount:mine.length,historyDays:hDays,minOrders:MIN_ORDERS,minHistoryDays:MIN_HISTORY_DAYS};
  if(!base.eligible){
    return {...base,type:'cold',id:'profile-build',title:'Build your shopping profile',description:`Complete ${Math.max(0,MIN_ORDERS-mine.length)} more order${MIN_ORDERS-mine.length===1?'':'s'} to unlock a personalised shopping goal.`,rationale:`Personalisation starts after ${MIN_ORDERS} completed orders and ${MIN_HISTORY_DAYS} days of history.`,actionLabel:'Keep shopping',progress:Math.min(mine.length,MIN_ORDERS),target:MIN_ORDERS};
  }
  const search=searchSignals(queries,mine,catalog,phone).find(x=>x.count>=2 && !dismissed.includes('search:'+x.query));
  if(search){return {...base,type:'search',id:'search:'+search.query,title:`Try ${search.query} this week`,description:`You searched for “${search.query}” more than once without buying it.`,rationale:'Based on repeated product-search activity with no matching purchase.',actionLabel:'Search again',progress:Math.min(search.count,3),target:3,query:search.query};}
  const comp=chooseComplement(itemCounts(mine),catalog);
  if(comp && !dismissed.includes('complement:'+comp.item)){return {...base,type:'complement',id:'complement:'+comp.item,title:`Complete your ${comp.item} basket`,description:`You buy ${comp.item} regularly. ${comp.comp} is a useful complement you have not picked up yet.`,rationale:'Based on frequently purchased staples and a known grocery pairing.',actionLabel:`Find ${comp.comp}`,progress:0,target:1,query:comp.comp};}
  const cadence=categoryCadence(mine).find(x=>x.avgDays>=4 && x.dueDays>=Math.max(4,x.avgDays*1.15) && !dismissed.includes('cadence:'+x.cat));
  if(cadence){return {...base,type:'cadence',id:'cadence:'+cadence.cat,title:`Your ${cadence.cat} restock may be due`,description:`Your usual ${cadence.cat} purchases are around every ${Math.round(cadence.avgDays)} days, and it has been ${Math.floor(cadence.dueDays)} days since the last one.`,rationale:'Based on your own category purchase cadence.',actionLabel:`Shop ${cadence.cat}`,progress:Math.min(cadence.dueDays,Math.round(cadence.avgDays)),target:Math.max(1,Math.round(cadence.avgDays)),category:cadence.cat};}
  const top=[...itemCounts(mine).entries()].sort((a,b)=>b[1]-a[1])[0];
  return {...base,type:'fallback',id:'useful-pick',title:top?`A useful pick for your ${top[0]} routine`:'Your personalised daily pick',description:top?`Based on what you buy most often, explore a useful companion item today.`:'Explore one product selected from your shopping behaviour.',rationale:'Based on your completed-order history.',actionLabel:'View Daily Pick',progress:0,target:1};
}

function dateKey(date=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function weekKey(date=new Date()){
  const d=new Date(date);const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return dateKey(d);
}
function monthKey(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit'}).formatToParts(date);return parts.find(x=>x.type==='year').value+'-'+parts.find(x=>x.type==='month').value;
}
function engageStreak(record,now=new Date()){
  const r=record||{current:0,best:0,lastDate:null,days:[],claimed:[]};const today=dateKey(now);const yesterday=dateKey(new Date(now.getTime()-DAY_MS));
  if(r.lastDate===today)return r;
  r.current=r.lastDate===yesterday?(Number(r.current)||0)+1:1;r.best=Math.max(Number(r.best)||0,r.current);r.lastDate=today;r.days=Array.isArray(r.days)?r.days:[];r.days=[...new Set([...r.days,today])].slice(-120);r.claimed=Array.isArray(r.claimed)?r.claimed:[];return r;
}
function streakSummary(record,now=new Date()){
  const r=record||{};const mk=monthKey(now),wk=weekKey(now);const activeDays=r.days||[];const weekly=activeDays.filter(x=>weekKey(new Date(x+'T12:00:00Z'))===wk).length;const monthly=activeDays.filter(x=>x.slice(0,7)===mk).length;
  return {current:Number(r.current)||0,best:Number(r.best)||0,lastDate:r.lastDate||null,weekly,monthly,claimed:r.claimed||[],nextReward:[3,7,14,30].find(x=>x>(Number(r.current)||0))||null};
}
module.exports={MIN_ORDERS,MIN_HISTORY_DAYS,completedOrders,historyDays,goalFor,dateKey,weekKey,monthKey,engageStreak,streakSummary};
