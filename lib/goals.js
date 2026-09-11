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

/* Gamified reward ladder + UAE calendar streak engine.
   Business rule: 7 active UAE days unlock 5%; one completed order in the
   same UAE week upgrades the reward by another configured 5%; a second order
   upgrades it again, capped at the configured maximum (default 15%). */
const DEFAULT_STREAK_CONFIG = {
  weeklyCycleDays: 7,
  timezone: 'Asia/Dubai',
  portalVisitActive: true,
  searchActive: true,
  cartAddActive: true,
  baseRewardPct: 5,
  order1AdditionalPct: 5,
  order2AdditionalPct: 5,
  maxRewardPct: 15,
  couponValidityDays: 30,
  minOrderValue: 0,
  autoGenerateCoupons: true,
  dailyGoalTitle: 'Your personalised daily pick',
  dailyGoalMessage: 'Stay active for 7 days and unlock up to 15% off!',
};
function sanitizeStreakConfig(input={}) {
  const x={...DEFAULT_STREAK_CONFIG,...(input||{})};
  const num=(v,f,min,max)=>{const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):f};
  const baseRewardPct=num(x.baseRewardPct,5,0,50);
  const order1AdditionalPct=num(x.order1AdditionalPct,5,0,50);
  const order2AdditionalPct=num(x.order2AdditionalPct,5,0,50);
  const maxRewardPct=Math.max(baseRewardPct,num(x.maxRewardPct,15,1,50));
  return {
    weeklyCycleDays: 7,
    timezone: 'Asia/Dubai',
    portalVisitActive: x.portalVisitActive!==false,
    searchActive: x.searchActive!==false,
    cartAddActive: x.cartAddActive!==false,
    baseRewardPct,
    order1AdditionalPct,
    order2AdditionalPct,
    maxRewardPct,
    couponValidityDays: Math.round(num(x.couponValidityDays,30,1,365)),
    minOrderValue: Math.round(num(x.minOrderValue,0,0,100000)*100)/100,
    autoGenerateCoupons: x.autoGenerateCoupons!==false,
    dailyGoalTitle: String(x.dailyGoalTitle||DEFAULT_STREAK_CONFIG.dailyGoalTitle).slice(0,80),
    dailyGoalMessage: String(x.dailyGoalMessage||DEFAULT_STREAK_CONFIG.dailyGoalMessage).slice(0,220),
  };
}
function norm(s){return String(s||'').trim().toLowerCase()}
function uaeParts(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(date);
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return {year:Number(get('year')),month:Number(get('month')),day:Number(get('day')),weekday:get('weekday')};
}
function dateKey(date=new Date()){
  const p=uaeParts(date);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}
function monthKey(date=new Date()){
  const p=uaeParts(date);return `${p.year}-${String(p.month).padStart(2,'0')}`;
}
function daysInCurrentMonth(date=new Date()){
  const p=uaeParts(date);return new Date(Date.UTC(p.year,p.month,0)).getUTCDate();
}
function calendarProgress(date=new Date()){
  const p=uaeParts(date),days=daysInCurrentMonth(date);
  return {dayOfMonth:p.day,daysInMonth:days,label:`${p.day}/${days}`,percent:Math.round((p.day/days)*100),dateKey:dateKey(date),monthKey:monthKey(date)};
}
const WD={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
function weekKey(date=new Date()){
  const p=uaeParts(date);const wd=WD[p.weekday]||0;const base=Date.UTC(p.year,p.month-1,p.day,12);const monday=new Date(base-(wd===0?6:wd-1)*DAY_MS);return dateKey(monday);
}
function weekDayList(date=new Date()){
  const p=uaeParts(date);const wd=WD[p.weekday]||0;const monday=new Date(Date.UTC(p.year,p.month-1,p.day,12)-(wd===0?6:wd-1)*DAY_MS);
  return Array.from({length:7},(_,i)=>{const d=new Date(monday.getTime()+i*DAY_MS);const q=uaeParts(d);return {key:dateKey(d),label:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],short:['M','T','W','T','F','S','S'][i],day:q.day}});
}
function rewardSummary(weeklyActiveDays,weeklyOrders,config={}){
  const c=sanitizeStreakConfig(config),days=Number(weeklyActiveDays)||0,orders=Number(weeklyOrders)||0;
  const baseUnlocked=days>=7;
  const p1=baseUnlocked?c.baseRewardPct:0;
  const p2=baseUnlocked&&orders>=1?Math.min(c.maxRewardPct,p1+c.order1AdditionalPct):0;
  const p3=baseUnlocked&&orders>=2?Math.min(c.maxRewardPct,p2+c.order2AdditionalPct):0;
  const levels=[
    {id:'base',label:'7 active days',short:'5% reward',pct:p1,unlocked:baseUnlocked},
    {id:'order1',label:'7 active days + 1 order',short:'10% total',pct:p2,unlocked:baseUnlocked&&orders>=1},
    {id:'order2',label:'7 active days + 2 orders',short:'15% total',pct:p3,unlocked:baseUnlocked&&orders>=2},
  ];
  levels[0].pct=c.baseRewardPct;
  levels[1].pct=Math.min(c.maxRewardPct,c.baseRewardPct+c.order1AdditionalPct);
  levels[2].pct=Math.min(c.maxRewardPct,c.baseRewardPct+c.order1AdditionalPct+c.order2AdditionalPct);
  const eligible=levels.filter(x=>x.unlocked).slice(-1)[0]||null;
  const next=!baseUnlocked?'7 active days':orders<1?'1 completed order':orders<2?'2 completed orders':'Maximum reward reached';
  return {levels,eligible,currentPct:eligible?eligible.pct:0,next,maxPct:c.maxRewardPct};
}
function actionEnabled(action,config={}){
  const c=sanitizeStreakConfig(config);
  return action==='portal_visit'?c.portalVisitActive:action==='search'?c.searchActive:action==='cart_add'?c.cartAddActive:false;
}
function engageStreak(record,now=new Date(),action='portal_visit',config={}){
  const r=record||{current:0,best:0,lastDate:null,days:[],claimedWeeks:{},activityLog:{}};
  r.current=Number(r.current)||0;r.best=Number(r.best)||0;r.days=Array.isArray(r.days)?r.days:[];r.claimedWeeks=(r.claimedWeeks&&typeof r.claimedWeeks==='object')?r.claimedWeeks:{};r.activityLog=(r.activityLog&&typeof r.activityLog==='object')?r.activityLog:{};
  if(!actionEnabled(action,config))return r;
  const today=dateKey(now),yesterday=dateKey(new Date(now.getTime()-DAY_MS));
  r.activityLog[today]=[...new Set([...(Array.isArray(r.activityLog[today])?r.activityLog[today]:[]),action])].slice(0,8);
  if(r.lastDate===today)return r;
  r.current=r.lastDate===yesterday?r.current+1:1;r.best=Math.max(r.best,r.current);r.lastDate=today;r.days=[...new Set([...r.days,today])].slice(-366);
  return r;
}
function unclaimedRewards(record){ return []; }
function streakSummary(record,now=new Date(),config={},weeklyOrders=0){
  const r=record||{},c=sanitizeStreakConfig(config),today=dateKey(now),wk=weekKey(now),mk=monthKey(now),activeDays=Array.isArray(r.days)?r.days:[];
  const weekDays=weekDayList(now);const activeWeekDays=activeDays.filter(x=>weekKey(new Date(x+'T12:00:00Z'))===wk);const weekly=activeWeekDays.length;
  const monthlyActive=activeDays.filter(x=>x.slice(0,7)===mk).length;
  const todayActions=Array.isArray(r.activityLog?.[today])?r.activityLog[today]:[];
  const reward=rewardSummary(weekly,weeklyOrders,c);
  const cal=calendarProgress(now);
  return {current:Number(r.current)||0,best:Number(r.best)||0,lastDate:r.lastDate||null,weekKey:wk,weekly,activeWeekDays,monthly:monthlyActive,weeklyOrders:Number(weeklyOrders)||0,claimed:Object.values(r.claimedWeeks||{}),todayActive:activeDays.includes(today),todayActions,weekDays,calendar:cal,claimedWeeks:r.claimedWeeks||{},reward,rewardTiers:reward.levels,config:c,nextReward:reward.next};
}
module.exports={MIN_ORDERS,MIN_HISTORY_DAYS,completedOrders,historyDays,goalFor,dateKey,weekKey,monthKey,daysInCurrentMonth,calendarProgress,weekDayList,engageStreak,streakSummary,rewardSummary,sanitizeStreakConfig,DEFAULT_STREAK_CONFIG,rewardTierFor:()=>null,unclaimedRewards};
