/* DevX NeXus — customer HOME navigation, 2D map edition (additive).
   Loaded after devx-nav3d.js. It gives the Home-page Store Mode card
   (#homeStoreNav3d) and the guided "Stop X of N" screen a flat,
   Google-Maps-style map: blue route line, direction arrows, numbered pins, a
   small walking person and a turn banner. A 2D | 3D switch brings the original
   3D views back at any time. The route engine and the Admin map are not touched. Route data still comes from the published Admin map through
   navStopPoint / navAStarSegment / navRouteObstacles / buildStoreNavRoute. */
(function(){
  'use strict';
  if(typeof navLayoutEls !== 'function' || typeof navAStarSegment !== 'function') return;

  const NS = 'http://www.w3.org/2000/svg';
  const HOME = document.getElementById('homeStoreNav3d');
  const ORIG_HTML = HOME ? HOME.innerHTML : '';              /* the original 3D card markup, kept for the 2D ⇄ 3D switch */
  const render3dHome = window.renderHomeStoreNav3D;           /* the existing 3D home renderer, untouched */
  let viewMode = '2d';
  try{ if(localStorage.getItem('devx-home-nav-view') === '3d') viewMode = '3d'; }catch(e){}
  const WALK_PREVIEW = 2.3;   /* m/s the little person moves on screen */
  const WALK_REAL = 1.1;      /* m/s used for the time estimate */
  const STOP_PAUSE = 1.7, END_PAUSE = 3.2;

  /* ───────── styles ───────── */
  const css = `
#homeStoreNav3d.dx2{background:#fff;border:1px solid #dfe3e8;box-shadow:0 10px 28px rgba(32,33,36,.13);color:#202124}
.dx2-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-bottom:1px solid #eceff1}
.dx2-head-copy{min-width:0;flex:1}
.dx2-kicker{font-size:7.5px;font-weight:900;letter-spacing:.11em;color:#1a73e8;text-transform:uppercase}
.dx2-title{font-size:12.5px;font-weight:900;margin-top:2px;color:#202124}
.dx2-sub{font-size:8px;color:#5f6368;margin-top:2px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dx2-seg{display:flex;background:#f1f3f4;border-radius:10px;padding:2px;flex-shrink:0}
.dx2-seg button{border:0;background:none;color:#5f6368;border-radius:8px;padding:6px 7px;font:800 8px 'Montserrat',sans-serif;cursor:pointer}
.dx2-seg button.active{background:#fff;color:#1a73e8;box-shadow:0 1px 3px rgba(60,64,67,.25)}
.dx2-dim{display:flex;background:#e8f0fe;border-radius:10px;padding:2px;flex-shrink:0}
.dx2-dim button{border:0;background:none;color:#5f6368;border-radius:8px;padding:6px 8px;font:900 8px 'Montserrat',sans-serif;cursor:pointer}
.dx2-dim button.active{background:#1a73e8;color:#fff}
.dx2-to2d{border:1px solid #7CFFA8!important;color:#7CFFA8!important;background:rgba(124,255,168,.1)!important}
.dx2-card{margin:0 0 12px;border:1px solid #dfe3e8;border-radius:18px;background:#fff;overflow:hidden;box-shadow:0 8px 22px rgba(32,33,36,.12);color:#202124;text-align:left}
.dx2-card .dx2-map{height:330px}
.store-nav-live-map .dx2-card{margin:0}
.dx2-map .dx2-svg{width:100%;height:100%;border-radius:0}
.store-nav-3d-actions .dx2-to2d{padding:6px 7px}
.dx2-map{position:relative;height:340px;background:#e6e9ed;overflow:hidden;user-select:none;-webkit-user-select:none}
.dx2-svg{display:block;width:100%;height:100%;touch-action:pan-y}
.dx2-map.zoomed .dx2-svg{touch-action:none;cursor:grab}
.dx2-map.zoomed .dx2-svg:active{cursor:grabbing}
.dx2-svg text{font-family:'Montserrat',Arial,sans-serif;pointer-events:none}
.dx2-turn{position:absolute;left:8px;right:8px;top:8px;z-index:3;border-radius:13px;background:#0f7b45;color:#fff;box-shadow:0 4px 14px rgba(15,60,35,.32);overflow:hidden}
.dx2-turn.arrived{background:#1a73e8}
.dx2-turn.idle{background:#3c4043}
.dx2-turn-main{display:flex;align-items:center;gap:10px;padding:9px 11px}
.dx2-turn-ic{width:30px;height:30px;flex-shrink:0}
.dx2-turn-ic svg,.dx2-then svg,.dx2-step-ic svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.dx2-turn-copy{min-width:0;flex:1}
.dx2-turn-dist{font-size:15px;font-weight:900;line-height:1.1}
.dx2-turn-text{font-size:9.5px;font-weight:700;opacity:.95;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dx2-then{display:none;align-items:center;gap:6px;padding:5px 11px;background:rgba(0,0,0,.2);font-size:8px;font-weight:700}
.dx2-then svg{width:13px;height:13px;flex-shrink:0}
.dx2-then b{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dx2-ctrl{position:absolute;right:8px;bottom:10px;z-index:3;display:flex;flex-direction:column;gap:6px}
.dx2-ctrl button{width:32px;height:32px;border:0;border-radius:50%;background:#fff;color:#3c4043;box-shadow:0 1px 5px rgba(60,64,67,.35);font:900 16px/1 Arial,sans-serif;cursor:pointer;display:grid;place-items:center;padding:0}
.dx2-ctrl button svg{width:16px;height:16px;fill:none;stroke:#1a73e8;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.dx2-chip{position:absolute;left:8px;bottom:10px;z-index:3;background:#fff;color:#3c4043;border-radius:999px;padding:5px 9px;font-size:8px;font-weight:800;box-shadow:0 1px 5px rgba(60,64,67,.3)}
.dx2-foot{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-top:1px solid #eceff1}
.dx2-eta{min-width:0;flex:1}
.dx2-eta b{display:block;font-size:14px;font-weight:900;color:#188038;line-height:1.15}
.dx2-eta span{display:block;font-size:8.5px;font-weight:700;color:#5f6368;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dx2-btn{border:1px solid #dadce0;background:#fff;color:#1a73e8;border-radius:999px;padding:8px 12px;font:800 9px 'Montserrat',sans-serif;cursor:pointer;flex-shrink:0}
.dx2-btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff;display:flex;align-items:center;gap:5px}
.dx2-btn.primary svg{width:11px;height:11px;fill:#fff}
.dx2-steps{display:none;max-height:210px;overflow:auto;border-top:1px solid #eceff1;background:#fff;padding:4px 12px 8px}
.dx2-steps.on{display:block}
.dx2-step{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f3f4}
.dx2-step:last-child{border-bottom:0}
.dx2-step-ic{width:18px;height:18px;flex-shrink:0;color:#5f6368}
.dx2-step.stop .dx2-step-ic{color:#d93025}
.dx2-step-copy{min-width:0;flex:1;font-size:9.5px;font-weight:700;color:#202124;line-height:1.35}
.dx2-step-copy small{display:block;font-size:8px;font-weight:600;color:#5f6368}
.dx2-step-d{font-size:8.5px;font-weight:800;color:#5f6368;flex-shrink:0}
@media(max-width:430px){.dx2-map{height:310px}.dx2-title{font-size:11.5px}}
`;
  function injectCss(){ if(document.getElementById('dx2-style')) return; const s = document.createElement('style'); s.id = 'dx2-style'; s.textContent = css; document.head.appendChild(s); }

  const ICONS = {
    straight:'<path d="M12 21V5M6 11l6-6 6 6"/>',
    left:'<path d="M17 21v-8a4 4 0 0 0-4-4H5M9 5L5 9l4 4"/>',
    right:'<path d="M7 21v-8a4 4 0 0 1 4-4h8M15 5l4 4-4 4"/>',
    'slight-left':'<path d="M15 21v-6l-7-7M8 14V8h6"/>',
    'slight-right':'<path d="M9 21v-6l7-7M16 14V8h-6"/>',
    uturn:'<path d="M8 21V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4"/>',
    arrive:'<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/>'
  };
  const icon = t => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t] || ICONS.straight}</svg>`;
  const fmtM = m => m < 1 ? 'Now' : `${Math.round(m)} m`;
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])));
  const el = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); if(attrs) for(const k in attrs) n.setAttribute(k, attrs[k]); if(parent) parent.appendChild(n); return n; };
  const num = v => (Math.round(v*100)/100).toString();

  /* ───────── geometry helpers ───────── */
  function dims(){ const c = STORE_NAV_MAP_CONFIG || {}; return { W:Math.max(10, Number(c.canvasW) || 40), D:Math.max(8, Number(c.canvasH) || 28) }; }
  function losFree(a, b, obs){
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)/0.6));
    for(let i = 1; i < n; i++){ const t = i/n; if(navCellBlocked(a.x + (b.x - a.x)*t, a.y + (b.y - a.y)*t, obs)) return false; }
    return true;
  }
  /* string-pull the grid staircase into natural walking lines */
  function smooth(points, obs){
    if(!points || points.length < 3) return points || [];
    const out = [points[0]]; let i = 0;
    while(i < points.length - 1){ let j = points.length - 1; while(j > i + 1 && !losFree(points[i], points[j], obs)) j--; out.push(points[j]); i = j; }
    return out;
  }
  function nearestLandmark(pct){
    let best = null, bd = 9;
    navLayoutEls().forEach(e => {
      if(!['aisle','rack','checkout','service','restroom','entry','exit'].includes(String(e.type || ''))) return;
      const x = Number(e.x) || 0, y = Number(e.y) || 0, w = Number(e.w) || 1, h = Number(e.h) || 1;
      const dx = Math.max(x - pct.x, 0, pct.x - (x + w)), dy = Math.max(y - pct.y, 0, pct.y - (y + h)), d = Math.hypot(dx, dy);
      if(d < bd){ bd = d; best = e; }
    });
    return best ? String(best.label || best.type || '').trim() : '';
  }
  const stopShort = s => !s ? 'your stop' : (s.isCheckout ? 'the checkout' : (s.loc ? `Aisle ${s.loc.aisle}` : 'your stop'));
  const stopLong = s => !s ? 'Your stop' : (s.isCheckout ? 'Checkout counter' : (s.loc ? `Aisle ${s.loc.aisle} · Rack ${s.loc.rack} · Shelf ${s.loc.shelf}` : 'Store location'));
  function pickText(s){
    if(!s) return '';
    if(s.isCheckout) return 'Pay here and you are done';
    const items = (s.items || []).map(x => x.name + (x.qty > 1 ? ' ×' + x.qty : '')).filter(Boolean);
    return items.length ? 'Pick ' + items.join(', ') : 'Shelf ' + (s.loc ? s.loc.shelf : '');
  }

  /* Build the walk for stops lo…hi (whole cart on Home, one leg in the guide) as one rounded line. */
  function buildRoute(stops, lo, hi){
    const cfg = STORE_NAV_MAP_CONFIG || {}, { W, D } = dims(), obs = navRouteObstacles();
    const M = p => ({ x:p.x/100*W, y:p.y/100*D, px:p.x, py:p.y });
    let from = cfg.entry ? { x:Number(cfg.entry.x) || 50, y:Number(cfg.entry.y) || 94 } : { x:50, y:94 };
    let verts = null; const pins = [];
    stops.forEach((stop, i) => {
      const target = navStopPoint(stop, from); if(!target) return;
      const state = i < lo ? 'done' : (i > hi ? 'later' : 'active');
      pins.push({ i, x:target.x/100*W, y:target.y/100*D, stop, state });
      if(state !== 'active'){ from = target; return; }
      if(!verts) verts = [Object.assign(M(from), { stop:-1 })];
      let seg = navAStarSegment(from, target, obs).slice();
      seg[0] = from; seg.push(target);
      seg = smooth(typeof navSimplifyPath === 'function' ? navSimplifyPath(seg) : seg, obs);
      for(let k = 1; k < seg.length; k++){
        const v = M(seg[k]), q = verts[verts.length - 1];
        if(Math.hypot(v.x - q.x, v.y - q.y) < .05){ if(k === seg.length - 1) q.stop = i; continue; }
        v.stop = k === seg.length - 1 ? i : -1; verts.push(v);
      }
      from = target;
    });
    if(!verts) verts = [Object.assign(M(from), { stop:-1 })];
    const act = pins.filter(p => p.state === 'active');
    /* dense, corner-rounded sampling */
    const pts = [], cum = [];
    const push = (x, y) => { const n = pts.length; if(n && Math.hypot(x - pts[n-1].x, y - pts[n-1].y) < 1e-4) return; cum.push(n ? cum[n-1] + Math.hypot(x - pts[n-1].x, y - pts[n-1].y) : 0); pts.push({ x, y }); };
    const man = [], stopAt = {};
    push(verts[0].x, verts[0].y);
    for(let i = 1; i < verts.length; i++){
      const a = verts[i-1], v = verts[i], b = verts[i+1];
      if(!b || v.stop >= 0){
        push(v.x, v.y);
        if(v.stop >= 0){ stopAt[v.stop] = cum[cum.length - 1]; man.push({ at:cum[cum.length - 1], type:'arrive', stop:v.stop, text:stopLong(stops[v.stop]), sub:pickText(stops[v.stop]) }); }
        continue;
      }
      const l1 = Math.hypot(v.x - a.x, v.y - a.y), l2 = Math.hypot(b.x - v.x, b.y - v.y);
      const d1 = { x:(v.x - a.x)/l1, y:(v.y - a.y)/l1 }, d2 = { x:(b.x - v.x)/l2, y:(b.y - v.y)/l2 };
      const dot = Math.max(-1, Math.min(1, d1.x*d2.x + d1.y*d2.y)), ang = Math.acos(dot)*180/Math.PI, cross = d1.x*d2.y - d1.y*d2.x;
      const r = Math.min(.9, l1*.45, l2*.45), p0 = { x:v.x - d1.x*r, y:v.y - d1.y*r }, p1 = { x:v.x + d2.x*r, y:v.y + d2.y*r };
      push(p0.x, p0.y);
      const at = cum[cum.length - 1];
      for(let t = 1; t <= 8; t++){ const k = t/8, m = 1 - k; push(m*m*p0.x + 2*m*k*v.x + k*k*p1.x, m*m*p0.y + 2*m*k*v.y + k*k*p1.y); }
      if(ang >= 24){
        const side = cross > 0 ? 'right' : 'left', slight = ang < 58, uturn = ang > 152, lm = nearestLandmark({ x:v.px, y:v.py });
        const verb = uturn ? 'Make a U-turn' : (slight ? `Bear ${side}` : `Turn ${side}`);
        man.push({ at, type:uturn ? 'uturn' : (slight ? 'slight-' + side : side), text:lm ? `${verb} at ${lm}` : verb });
      }
    }
    const total = cum.length ? cum[cum.length - 1] : 0;
    const firstStop = stops[(act[0] || {}).i];
    man.unshift({ at:0, type:'straight', text:`Head towards ${stopShort(firstStop)}`, head:true });
    man.sort((p, q) => p.at - q.at);
    /* after every stop, say where we head next */
    const stopOrder = act.map(p => p.i);
    man.forEach(m => { if(m.type === 'arrive'){ const k = stopOrder.indexOf(m.stop); m.next = k >= 0 && k < stopOrder.length - 1 ? stops[stopOrder[k+1]] : null; } });
    function at(s){
      if(!pts.length) return { x:W/2, y:D*.9, dx:0, dy:-1 };
      if(pts.length === 1) return { x:pts[0].x, y:pts[0].y, dx:0, dy:-1 };
      s = Math.max(0, Math.min(total, s));
      let lo = 0, hi = cum.length - 1;
      while(hi - lo > 1){ const mid = (lo + hi) >> 1; if(cum[mid] <= s) lo = mid; else hi = mid; }
      const a = pts[lo], b = pts[hi], L = (cum[hi] - cum[lo]) || 1, t = (s - cum[lo])/L;
      return { x:a.x + (b.x - a.x)*t, y:a.y + (b.y - a.y)*t, dx:(b.x - a.x)/L, dy:(b.y - a.y)/L };
    }
    const d = pts.map((p, i) => (i ? 'L' : 'M') + num(p.x) + ' ' + num(p.y)).join(' ');
    return { pts, total, d, at, man, pins, stopAt, start:verts[0], W, D };
  }

  /* ───────── one map instance (Home card, guided screen) ───────── */
  function createNav(P, opt){
    const st = { sig:'', built:false, mode:opt.mode || 'overview', vb:null, base:null, route:null, s:0, pause:0, seg:0, phase:0, hudKey:'', stepsOpen:false, raf:0, last:0, ro:null, ptrs:new Map(), pinch:0 };

    function ensureCard(){
      const host = opt.host(); if(!host) return null;
      if(host.querySelector('#' + P + 'Svg')) return host;
      injectCss();
      if(st.ro){ try{ st.ro.disconnect(); }catch(e){} st.ro = null; }
      st.built = false; st.sig = ''; st.gfx = null; st.stepsOpen = false;
      if(opt.before) opt.before(host);
      const inner = `
        <div class="dx2-head">
          <div class="dx2-head-copy">
            <div class="dx2-kicker">${opt.kicker}</div>
            <div class="dx2-title">${opt.title}</div>
            <div class="dx2-sub" id="${P}Meta"></div>
          </div>
          <div class="dx2-dim" role="group" aria-label="Map type">
            <button type="button" class="active" aria-pressed="true">2D</button>
            <button type="button" id="${P}To3dBtn" aria-pressed="false">3D</button>
          </div>
          <div class="dx2-seg">
            <button type="button" id="${P}OverviewBtn">Overview</button>
            <button type="button" id="${P}FollowBtn">Follow</button>
          </div>
        </div>
        <div class="dx2-map" id="${P}Map">
          <svg class="dx2-svg" id="${P}Svg" role="img" aria-label="Store map with your walking route"></svg>
          <div class="dx2-turn" id="${P}Turn">
            <div class="dx2-turn-main"><div class="dx2-turn-ic"></div><div class="dx2-turn-copy"><div class="dx2-turn-dist"></div><div class="dx2-turn-text"></div></div></div>
            <div class="dx2-then"></div>
          </div>
          <div class="dx2-chip" id="${P}Chip"></div>
          <div class="dx2-ctrl">
            <button type="button" id="${P}Recenter" aria-label="Re-centre on me" title="Re-centre"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
            <button type="button" id="${P}ZoomIn" aria-label="Zoom in">+</button>
            <button type="button" id="${P}ZoomOut" aria-label="Zoom out">−</button>
          </div>
        </div>` + (opt.foot ? `
        <div class="dx2-foot">
          <div class="dx2-eta"><b id="${P}EtaMain">—</b><span id="${P}EtaSub"></span></div>
          <button type="button" class="dx2-btn" id="${P}StepsBtn">Steps</button>
          <button type="button" class="dx2-btn primary" id="${P}StartBtn"><svg viewBox="0 0 24 24"><path d="M12 2l8 19-8-4.5L4 21z"/></svg>Start</button>
        </div>
        <div class="dx2-steps" id="${P}Steps"></div>` : '');
      host.innerHTML = opt.wrap ? `<div class="dx2-card">${inner}</div>` : inner;
      const on = (id, fn) => { const b = document.getElementById(P + id); if(b) b.addEventListener('click', fn); };
      on('To3dBtn', () => setViewMode('3d'));
      on('OverviewBtn', () => setMode('overview')); on('FollowBtn', () => setMode('follow')); on('Recenter', () => setMode('follow'));
      on('ZoomIn', () => zoomBy(.7)); on('ZoomOut', () => zoomBy(1/.7));
      on('StepsBtn', () => { st.stepsOpen = !st.stepsOpen; document.getElementById(P + 'Steps').classList.toggle('on', st.stepsOpen); document.getElementById(P + 'StepsBtn').textContent = st.stepsOpen ? 'Hide steps' : 'Steps'; });
      on('StartBtn', () => { if(typeof startStoreNavGuide === 'function') startStoreNavGuide(); });
      bindGestures(document.getElementById(P + 'Svg'));
      if('ResizeObserver' in window){ st.ro = new ResizeObserver(() => { if(st.built) refit(); }); st.ro.observe(document.getElementById(P + 'Map')); }
      else if(!st.resizeBound){ st.resizeBound = true; window.addEventListener('resize', () => { if(st.built && document.getElementById(P + 'Map')) refit(); }); }
      return host;
    }

    /* ───────── drawing ───────── */
    const STYLE = {
      aisle:['#e4e7eb','#c5cad3'], rack:['#e4e7eb','#c5cad3'], shelf:['#eceef1','#cfd4db'],
      checkout:['#fdecc0','#e9c46a'], entry:['#cdebd3','#7cc48c'], exit:['#e6dcf7','#b79be6'],
      restroom:['#dbe7fb','#a9c3ef'], service:['#fde0d6','#f0b199'], stairs:['#e8eaed','#c5cad3']
    };
    function drawMap(svg, route, ghostD){
      const cfg = STORE_NAV_MAP_CONFIG || {}, { W, D } = route, els = navLayoutEls();
      svg.innerHTML = '';
      const defs = el('defs', null, svg);
      defs.innerHTML = `<filter id="${P}Sh" x="-40%" y="-40%" width="180%" height="200%"><feDropShadow dx="0" dy=".12" stdDeviation=".14" flood-color="#202124" flood-opacity=".35"/></filter><radialGradient id="${P}Beam" cx="50%" cy="100%" r="100%"><stop offset="0" stop-color="#4285f4" stop-opacity=".5"/><stop offset="1" stop-color="#4285f4" stop-opacity="0"/></radialGradient>`;
      el('rect', { x:-W, y:-D, width:W*3, height:D*3, fill:'#e6e9ed' }, svg);
      el('rect', { x:0, y:0, width:W, height:D, rx:.5, fill:'#f8f6f0', stroke:'#b6bcc6', 'stroke-width':.14 }, svg);
      if(cfg.mapDataUrl && !els.length) el('image', { href:cfg.mapDataUrl, x:0, y:0, width:W, height:D, preserveAspectRatio:'none' }, svg);
      const targets = new Set(); route.pins.filter(p => p.state === 'active').map(p => p.stop).forEach(s => { if(s && s.loc && typeof navAisleElFor === 'function'){ const a = navAisleElFor(Number(s.loc.aisle) || 0); if(a) targets.add(a); } });
      const gEls = el('g', null, svg), labels = [];
      els.slice().sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0)).forEach(e => {
        const type = String(e.type || '').toLowerCase(), x = (Number(e.x) || 0)/100*W, y = (Number(e.y) || 0)/100*D, w = Math.max(.4, (Number(e.w) || 1)/100*W), h = Math.max(.4, (Number(e.h) || 1)/100*D);
        const g = el('g', { transform:`rotate(${Number(e.rotation) || 0} ${num(x + w/2)} ${num(y + h/2)})` }, gEls);
        const col = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#9aa0a6';
        let ink = '#5f6368';
        if(type === 'text'){ /* label only */ }
        else if(type === 'zone' || type === 'section'){ el('rect', { x:num(x), y:num(y), width:num(w), height:num(h), rx:.3, fill:col, 'fill-opacity':.16, stroke:col, 'stroke-opacity':.35, 'stroke-width':.06, 'stroke-dasharray':'.3 .25' }, g); }
        else {
          const hit = targets.has(e), s = hit ? ['#d2e3fc','#7baaf7'] : (STYLE[type] || ['#e8eaed','#c5cad3']);
          el('rect', { x:num(x), y:num(y), width:num(w), height:num(h), rx:Math.min(.28, w/4, h/4), fill:s[0], stroke:s[1], 'stroke-width':.08 }, g);
          if(hit) ink = '#174ea6';
        }
        const t = el('text', { x:0, y:0, 'font-size':20, 'text-anchor':'middle', 'dominant-baseline':'central', 'font-weight':800, fill:ink }, g);
        t.textContent = String(e.label || e.type || '');
        labels.push({ t, w, h, cx:x + w/2, cy:y + h/2, n:t.textContent.length || 1, tall:h > w*1.35 });
      });
      /* route: border, blue line, walked part, arrows */
      const gRoute = el('g', { fill:'none', 'stroke-linecap':'round', 'stroke-linejoin':'round' }, svg);
      const ghost = ghostD ? el('path', { d:ghostD, stroke:'#aecbfa' }, gRoute) : null;   /* rest of the cart route, faint */
      const border = el('path', { d:route.d, stroke:'#1558d6' }, gRoute), line = el('path', { d:route.d, stroke:'#4285f4' }, gRoute), walked = el('path', { d:route.d, stroke:'#9aa7b8' }, gRoute);
      const gArrows = el('g', null, svg), arrows = [];
      const startDot = el('g', null, svg);
      el('circle', { r:1, fill:'#fff', stroke:'#3c4043', 'stroke-width':.42 }, startDot);
      /* pins */
      const gPins = el('g', null, svg), pins = route.pins.map(p => {
        const g = el('g', { filter:'url(#' + P + 'Sh)' }, gPins), checkout = !!p.stop.isCheckout, fixed = p.state !== 'active';
        const body = el('path', { d:'M0 0 C-.5 -1.3 -1.55 -2 -1.55 -3.35 A1.55 1.55 0 1 1 1.55 -3.35 C1.55 -2 .5 -1.3 0 0 Z', fill:fixed ? (p.state === 'done' ? '#9aa0a6' : (checkout ? '#8fcea4' : '#f3a59f')) : (checkout ? '#188038' : '#ea4335'), stroke:fixed ? (p.state === 'done' ? '#80868b' : (checkout ? '#5fae7b' : '#dc7f78')) : (checkout ? '#0d652d' : '#b3261e'), 'stroke-width':.12 }, g);
        const t = el('text', { x:0, y:0, transform:'translate(0 -3.3) scale(.1)', 'text-anchor':'middle', 'dominant-baseline':'central', 'font-size':15.5, 'font-weight':900, fill:'#fff' }, g);
        t.textContent = checkout ? '✓' : String(p.i + 1);
        return { g, body, p, checkout, fixed, at:route.stopAt[p.i] };
      });
      /* walker: blue heading beam + location halo + a little person */
      const walker = el('g', null, svg);
      const beam = el('path', { d:'M0 0 L-2.6 -5.2 A5.8 5.8 0 0 1 2.6 -5.2 Z', fill:'url(#' + P + 'Beam)' }, walker);
      const halo = el('circle', { r:2.4, fill:'#4285f4', 'fill-opacity':.18 }, walker);
      el('ellipse', { cx:0, cy:.15, rx:1.25, ry:.5, fill:'#202124', 'fill-opacity':.22 }, walker);
      const person = el('g', null, walker);
      const legL = el('line', { x1:-.32, y1:-1.55, x2:-.42, y2:-.1, stroke:'#174ea6', 'stroke-width':.56, 'stroke-linecap':'round' }, person);
      const legR = el('line', { x1:.32, y1:-1.55, x2:.42, y2:-.1, stroke:'#174ea6', 'stroke-width':.56, 'stroke-linecap':'round' }, person);
      const armL = el('line', { x1:-.72, y1:-2.75, x2:-1.05, y2:-1.7, stroke:'#f4b183', 'stroke-width':.42, 'stroke-linecap':'round' }, person);
      const armR = el('line', { x1:.72, y1:-2.75, x2:1.05, y2:-1.7, stroke:'#f4b183', 'stroke-width':.42, 'stroke-linecap':'round' }, person);
      el('rect', { x:-.78, y:-3.05, width:1.56, height:1.75, rx:.62, fill:'#1a73e8', stroke:'#fff', 'stroke-width':.16 }, person);
      el('circle', { cx:0, cy:-3.85, r:.78, fill:'#f8c9a4', stroke:'#fff', 'stroke-width':.16 }, person);
      el('path', { d:'M-.78 -3.95 A.78 .78 0 0 1 .78 -3.95 Q0 -4.35 -.78 -3.95 Z', fill:'#3c2f2f' }, person);
      return { ghost, border, line, walked, gArrows, arrows, startDot, pins, labels, walker, beam, halo, person, legL, legR, armL, armR };
    }

    /* ───────── view (zoom / pan / follow) ───────── */
    function baseView(){
      const map = document.getElementById(P + 'Map'), r = st.route; if(!map || !r) return null;
      const cw = Math.max(200, map.clientWidth), ch = Math.max(160, map.clientHeight), aspect = cw/ch;
      const turn = document.getElementById(P + 'Turn'), topPx = (turn ? turn.offsetHeight : 56) + 16, botPx = 14;
      /* fit the store into the area left free under the instruction banner */
      const availH = Math.max(60, ch - topPx - botPx), k = Math.min((cw - 20)/r.W, availH/r.D);
      const w = cw/k, h = ch/k;
      return { x:r.W/2 - w/2, y:r.D/2 - (topPx + availH/2)/k, w, h, aspect };
    }
    function clampView(v){
      const b = st.base; if(!b) return v;
      v.w = Math.max(7, Math.min(b.w, v.w)); v.h = v.w/b.aspect;
      v.x = Math.max(b.x, Math.min(b.x + b.w - v.w, v.x)); v.y = Math.max(b.y, Math.min(b.y + b.h - v.h, v.y));
      return v;
    }
    function applyView(){
      const svg = document.getElementById(P + 'Svg'), g = st.gfx, v = st.vb; if(!svg || !g || !v) return;
      svg.setAttribute('viewBox', `${num(v.x)} ${num(v.y)} ${num(v.w)} ${num(v.h)}`);
      const u = v.w/100; st.u = u;               /* 1u = 1% of the visible width */
      if(g.ghost) g.ghost.setAttribute('stroke-width', num(u*1.5)); g.border.setAttribute('stroke-width', num(u*2.5)); g.line.setAttribute('stroke-width', num(u*1.75)); g.walked.setAttribute('stroke-width', num(u*1.75));
      g.startDot.setAttribute('transform', `translate(${num(st.route.start.x)} ${num(st.route.start.y)}) scale(${num(u)})`);
      g.pins.forEach(p => p.g.setAttribute('transform', `translate(${num(p.p.x)} ${num(p.p.y)}) scale(${num(u*1.05)})`));
      g.labels.forEach(l => {
        const fs = Math.min(u*2.5, l.h*.5, l.w*.5), len = fs*.62*l.n;
        const fitsFlat = len <= l.w*.94 && fs <= l.h*.8, fitsTall = l.tall && len <= l.h*.94 && fs <= l.w*.8;
        if(fs < u*1.35 || (!fitsFlat && !fitsTall)){ l.t.setAttribute('display', 'none'); return; }
        l.t.removeAttribute('display');
        l.t.setAttribute('transform', `translate(${num(l.cx)} ${num(l.cy)})${!fitsFlat && fitsTall ? ' rotate(-90)' : ''} scale(${(fs/20).toFixed(4)})`);
      });
      /* direction arrows on the line, evenly spaced on screen */
      const spacing = Math.max(.9, u*5.2), want = st.route.total > spacing ? Math.min(140, Math.floor(st.route.total/spacing)) : 0;
      while(g.arrows.length < want) g.arrows.push(el('path', { d:'M-.42 .36 L0 -.3 L.42 .36', fill:'none', stroke:'#fff', 'stroke-width':.24, 'stroke-linecap':'round', 'stroke-linejoin':'round' }, g.gArrows));
      while(g.arrows.length > want) g.gArrows.removeChild(g.arrows.pop());
      st.spacing = spacing;
      const map = document.getElementById(P + 'Map'); if(map) map.classList.toggle('zoomed', st.base && v.w < st.base.w*.985);
      paint();
    }
    function setMode(mode){
      st.mode = mode;
      const o = document.getElementById(P + 'OverviewBtn'), f = document.getElementById(P + 'FollowBtn');
      if(o) o.classList.toggle('active', mode === 'overview'); if(f) f.classList.toggle('active', mode === 'follow');
      if(!st.base) return;
      if(mode === 'overview') st.vb = Object.assign({}, st.base);
      else if(mode === 'follow'){ const p = st.route.at(st.s), w = Math.max(9, Math.min(st.base.w*.52, 17)); st.vb = clampView({ x:p.x - w/2, y:p.y - (w/st.base.aspect)*.56, w, h:w/st.base.aspect }); }
      applyView();
    }
    function zoomBy(f, cx, cy){
      if(!st.vb || !st.base) return;
      const v = st.vb, px = cx == null ? v.x + v.w/2 : cx, py = cy == null ? v.y + v.h/2 : cy;
      const w = Math.max(7, Math.min(st.base.w, v.w*f)), k = w/v.w;
      st.vb = clampView({ x:px - (px - v.x)*k, y:py - (py - v.y)*k, w, h:w/st.base.aspect });
      if(st.vb.w >= st.base.w*.985) return setMode('overview');
      if(st.mode !== 'follow' || cx != null) st.mode = 'free';
      const o = document.getElementById(P + 'OverviewBtn'), fb = document.getElementById(P + 'FollowBtn');
      if(o) o.classList.remove('active'); if(fb) fb.classList.toggle('active', st.mode === 'follow');
      applyView();
    }
    function refit(){
      const b = baseView(); if(!b) return;
      const ratio = st.vb && st.base ? st.vb.w/st.base.w : 1, c = st.vb ? { x:st.vb.x + st.vb.w/2, y:st.vb.y + st.vb.h/2 } : null;
      st.base = b;
      if(st.mode === 'overview' || !c) st.vb = Object.assign({}, b);
      else { const w = b.w*ratio; st.vb = clampView({ x:c.x - w/2, y:c.y - (w/b.aspect)/2, w, h:w/b.aspect }); }
      applyView();
    }
    function bindGestures(svg){
      const toMap = ev => { const r = svg.getBoundingClientRect(), v = st.vb; return { x:v.x + (ev.clientX - r.left)/r.width*v.w, y:v.y + (ev.clientY - r.top)/r.height*v.h }; };
      const zoomed = () => st.vb && st.base && st.vb.w < st.base.w*.985;
      svg.addEventListener('pointerdown', ev => { if(!st.vb) return; st.ptrs.set(ev.pointerId, { x:ev.clientX, y:ev.clientY }); if(st.ptrs.size === 2){ const a = [...st.ptrs.values()]; st.pinch = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); } if(zoomed() || st.ptrs.size === 2){ try{ svg.setPointerCapture(ev.pointerId); }catch(e){} } });
      svg.addEventListener('pointermove', ev => {
        const p = st.ptrs.get(ev.pointerId); if(!p || !st.vb) return;
        const r = svg.getBoundingClientRect();
        if(st.ptrs.size === 2){
          p.x = ev.clientX; p.y = ev.clientY; const a = [...st.ptrs.values()], d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
          if(st.pinch > 0 && d > 0){ const c = toMap({ clientX:(a[0].x + a[1].x)/2, clientY:(a[0].y + a[1].y)/2 }); zoomBy(st.pinch/d, c.x, c.y); st.pinch = d; }
          return;
        }
        if(!zoomed()){ p.x = ev.clientX; p.y = ev.clientY; return; }
        const dx = (ev.clientX - p.x)/r.width*st.vb.w, dy = (ev.clientY - p.y)/r.height*st.vb.h; p.x = ev.clientX; p.y = ev.clientY;
        if(!dx && !dy) return;
        st.vb = clampView({ x:st.vb.x - dx, y:st.vb.y - dy, w:st.vb.w, h:st.vb.h });
        if(st.mode !== 'free'){ st.mode = 'free'; const f = document.getElementById(P + 'FollowBtn'), o = document.getElementById(P + 'OverviewBtn'); if(f) f.classList.remove('active'); if(o) o.classList.remove('active'); }
        applyView();
      });
      const up = ev => { st.ptrs.delete(ev.pointerId); if(st.ptrs.size < 2) st.pinch = 0; };
      svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up); svg.addEventListener('pointerleave', up);
      svg.addEventListener('wheel', ev => { if(!(ev.ctrlKey || ev.metaKey) || !st.vb) return; ev.preventDefault(); const c = toMap(ev); zoomBy(ev.deltaY > 0 ? 1.12 : .89, c.x, c.y); }, { passive:false });
    }

    /* ───────── per-frame paint ───────── */
    function paint(){
      const g = st.gfx, r = st.route; if(!g || !r) return;
      const u = st.u || 1, p = r.at(st.s), moving = st.pause <= 0 && r.total > 0 && st.s < r.total;
      const deg = Math.atan2(p.dx, -p.dy)*180/Math.PI;
      g.walker.setAttribute('transform', `translate(${num(p.x)} ${num(p.y)}) scale(${num(u*1.12)})`);
      g.beam.setAttribute('transform', `rotate(${num(deg)})`);
      const sw = moving ? Math.sin(st.phase) : 0, bob = moving ? Math.abs(Math.sin(st.phase))*.14 : 0;
      g.person.setAttribute('transform', `translate(0 ${num(-bob)})`);
      g.legL.setAttribute('x2', num(-.42 + sw*.5)); g.legR.setAttribute('x2', num(.42 - sw*.5));
      g.armL.setAttribute('x2', num(-1.05 - sw*.3)); g.armR.setAttribute('x2', num(1.05 + sw*.3));
      g.halo.setAttribute('r', num(2.3 + .35*Math.sin(performance.now()/420)));
      g.walked.setAttribute('stroke-dasharray', `${num(st.s)} ${num(r.total + 10)}`);
      if(g.arrows.length){
        const off = (performance.now()/1000*st.spacing*.45) % st.spacing;
        for(let i = 0; i < g.arrows.length; i++){
          const s = off + i*st.spacing, q = r.at(s);
          if(s > r.total - u*1.2 || Math.abs(s - st.s) < u*2.2){ g.arrows[i].setAttribute('display', 'none'); continue; }
          g.arrows[i].removeAttribute('display');
          g.arrows[i].setAttribute('transform', `translate(${num(q.x)} ${num(q.y)}) rotate(${num(Math.atan2(q.dx, -q.dy)*180/Math.PI)}) scale(${num(u*1.5)})`);
          g.arrows[i].setAttribute('stroke-opacity', s < st.s ? .55 : 1);
        }
      }
      g.pins.forEach(pin => { if(pin.fixed) return; const done = pin.at != null && st.s >= pin.at - .05 && !(st.s >= r.total - .05 && pin.at >= r.total - .05); const k = done ? 'd' : 'a'; if(pin.k === k) return; pin.k = k; pin.body.setAttribute('fill', done ? '#9aa0a6' : (pin.checkout ? '#188038' : '#ea4335')); pin.body.setAttribute('stroke', done ? '#80868b' : (pin.checkout ? '#0d652d' : '#b3261e')); });
    }
    function hud(){
      const r = st.route, box = document.getElementById(P + 'Turn'); if(!r || !box) return;
      const ms = r.man, sample = !!st.sample;
      let cur, nxt, dist, arrived = false, key;
      if(r.total <= 0){ cur = { type:'straight', text:'Add products to build your route' }; dist = -1; key = 'idle'; }
      else if(st.pause > 0 && st.arrivedM){ cur = st.arrivedM; arrived = true; dist = 0; key = 'A' + ms.indexOf(cur); nxt = cur.next ? { type:'straight', text:`Head towards ${stopShort(cur.next)}` } : null; }
      else { let k = ms.findIndex(m => m.at > st.s + .3 && !m.head); if(k < 0) k = ms.length - 1; cur = st.s < .4 && ms[0].head && ms[k].at > 3 ? ms[0] : ms[k]; nxt = cur.head ? ms[k] : ms[k+1]; dist = cur.head ? ms[k].at : Math.max(0, cur.at - st.s); key = (cur.head ? 'H' : k) + ''; }
      if(st.hudKey !== key){
        st.hudKey = key;
        box.classList.toggle('arrived', arrived); box.classList.toggle('idle', key === 'idle');
        box.querySelector('.dx2-turn-ic').innerHTML = icon(cur.type);
        box.querySelector('.dx2-turn-text').textContent = arrived ? `${cur.text}${cur.sub ? ' — ' + cur.sub : ''}` : (cur.type === 'arrive' ? `Arrive at ${cur.text}` : cur.text);
        const then = box.querySelector('.dx2-then');
        if(nxt){ then.innerHTML = `<span>Then</span>${icon(nxt.type)}<b>${E(nxt.type === 'arrive' ? 'Arrive at ' + nxt.text : nxt.text)}</b>`; then.style.display = 'flex'; } else then.style.display = 'none';
      }
      box.querySelector('.dx2-turn-dist').textContent = key === 'idle' ? 'Store map' : (arrived ? (sample ? 'Sample stop' : 'You have arrived') : fmtM(dist));
      const chip = document.getElementById(P + 'Chip');
      if(chip){ const left = Math.max(0, r.total - st.s); chip.textContent = r.total <= 0 ? 'You are at the entrance' : (left < .5 ? 'Route complete' : `${Math.round(left)} m left`); }
    }
    function frame(now){
      st.raf = requestAnimationFrame(frame);
      const svg = document.getElementById(P + 'Svg');
      if(!st.built || !svg || !svg.isConnected || svg.getBoundingClientRect().width === 0 || document.hidden){ st.last = now; return; }
      const dt = Math.min(.05, (now - (st.last || now))/1000); st.last = now;
      const r = st.route;
      if(r.total > 0 && !st.still){
        if(st.pause > 0){ st.pause -= dt; if(st.pause <= 0){ st.pause = 0; st.arrivedM = null; st.hudKey = ''; if(st.s >= r.total - 1e-3){ st.s = 0; st.seg = 0; } } }
        else {
          const stops = r.man.filter(m => m.type === 'arrive'), next = stops[st.seg], limit = next ? next.at : r.total;
          st.s = Math.min(limit, st.s + WALK_PREVIEW*dt); st.phase += dt*9;
          if(st.s >= limit - 1e-3){ st.arrivedM = next || null; st.seg++; st.pause = st.s >= r.total - 1e-3 ? END_PAUSE : STOP_PAUSE; }
        }
      }
      if(st.mode === 'follow' && st.vb){ const p = r.at(st.s), a = Math.min(1, dt*3.5), tx = p.x - st.vb.w/2, ty = p.y - st.vb.h*.56; const v = clampView({ x:st.vb.x + (tx - st.vb.x)*a, y:st.vb.y + (ty - st.vb.y)*a, w:st.vb.w, h:st.vb.h }); if(Math.abs(v.x - st.vb.x) > 1e-3 || Math.abs(v.y - st.vb.y) > 1e-3){ st.vb = v; document.getElementById(P + 'Svg').setAttribute('viewBox', `${num(v.x)} ${num(v.y)} ${num(v.w)} ${num(v.h)}`); } }
      paint();
      if(!st.lastHud || now - st.lastHud > 110){ st.lastHud = now; hud(); }
    }

    function renderSteps(route, sample){
      const box = document.getElementById(P + 'Steps'); if(!box) return;
      if(route.total <= 0){ box.innerHTML = '<div class="dx2-step"><div class="dx2-step-copy">Add products to your cart to see walking directions.</div></div>'; return; }
      let prev = 0;
      box.innerHTML = route.man.map(m => { const d = m.at - prev; prev = m.at; const stop = m.type === 'arrive';
        return `<div class="dx2-step ${stop ? 'stop' : ''}"><div class="dx2-step-ic">${icon(m.type)}</div><div class="dx2-step-copy">${E(stop ? m.text : m.text)}${stop && m.sub && !sample ? `<small>${E(m.sub)}</small>` : ''}</div><div class="dx2-step-d">${m.head ? '' : (d < 1 ? '' : Math.round(d) + ' m')}</div></div>`; }).join('');
    }

    /* draw stops lo…hi of the given stop list */
    function render(stops, lo, hi, o){
      o = o || {};
      if(!ensureCard()) return;
      const cfg = STORE_NAV_MAP_CONFIG || {}, { W, D } = dims(), svg = document.getElementById(P + 'Svg');
      const meta = document.getElementById(P + 'Meta'); if(meta) meta.textContent = o.meta || '';
      const sig = JSON.stringify([lo, hi, W, D, cfg.mapName, cfg.floor, cfg.entry, navLayoutEls().map(e => [e.type, e.x, e.y, e.w, e.h, e.rotation, e.label, e.color]), stops.map(s => [s.isCheckout ? 'c' : '', s.loc, (s.items || []).map(x => [x.name, x.qty])])]);
      if(sig === st.sig && st.built) return;
      st.sig = sig; st.sample = !!o.sample;
      st.route = buildRoute(stops, lo, hi);
      const partial = lo > 0 || hi < stops.length - 1;
      st.gfx = drawMap(svg, st.route, partial ? buildRoute(stops, 0, stops.length - 1).d : '');
      st.s = 0; st.pause = 0; st.seg = 0; st.arrivedM = null; st.hudKey = ''; st.phase = 0;
      st.still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const nStops = st.route.pins.filter(p => p.state === 'active' && !p.stop.isCheckout).length, mins = Math.max(1, Math.round((st.route.total/WALK_REAL + nStops*20)/60));
      const em = document.getElementById(P + 'EtaMain'), es = document.getElementById(P + 'EtaSub');
      if(em) em.textContent = st.route.total > 0 ? `${mins} min` : 'Store map';
      if(es) es.textContent = st.route.total > 0 ? `${Math.round(st.route.total)} m · ${st.sample ? 'sample route · add products for yours' : `${nStops} stop${nStops === 1 ? '' : 's'} · ends at checkout`}` : 'Add products to see your cart path';
      renderSteps(st.route, st.sample);
      st.built = true; hud();
      st.base = baseView(); if(st.mode === 'free') st.mode = opt.mode || 'overview'; setMode(st.mode);
      hud();
      if(!st.raf) st.raf = requestAnimationFrame(frame);
    }
    function reset(){ st.built = false; st.sig = ''; st.gfx = null; if(st.ro){ try{ st.ro.disconnect(); }catch(e){} st.ro = null; } }
    return { render, reset };
  }

  /* ───────── 2D ⇄ 3D switch + clean shutdown of the 3D scene / voice ───────── */
  const guideOpen = () => !!document.getElementById('storeNavGuide')?.classList.contains('on');
  const guideOwns3d = () => typeof STORE_NAV_3D !== 'undefined' && !!STORE_NAV_3D.canvas && STORE_NAV_3D.canvas.id === 'storeNav3dCanvas';
  function hushVoice(){ try{ if('speechSynthesis' in window) window.speechSynthesis.cancel(); }catch(e){} }
  function stop3d(){
    hushVoice();
    if(typeof STORE_NAV_3D === 'undefined') return;
    const S = STORE_NAV_3D; S.nav = null;
    if(S.renderer){
      try{ cancelAnimationFrame(S.frame); }catch(e){}
      try{ if(S.controls && S.controls.dispose) S.controls.dispose(); S.renderer.dispose(); if(S.renderer.forceContextLoss) S.renderer.forceContextLoss(); }catch(e){}
      S.renderer = null; S.scene = null; S.camera = null; S.controls = null; S.objects = []; S.routeDots = []; S.walkers = []; S.route = null;
    }
    S.canvas = null; S.root = null;
  }
  function to2dButton(){ const b = document.createElement('button'); b.type = 'button'; b.className = 'dx2-to2d'; b.textContent = '2D map'; b.title = 'Switch to the 2D map'; b.addEventListener('click', () => setViewMode('2d')); return b; }
  function setViewMode(mode){
    viewMode = mode === '3d' ? '3d' : '2d';
    try{ localStorage.setItem('devx-home-nav-view', viewMode); }catch(e){}
    if(guideOpen()) window.renderStoreNavGuide(); else window.renderHomeStoreNav3D();
  }

  /* ───────── HOME card ───────── */
  const H = createNav('dx2', {
    host:() => document.getElementById('homeStoreNav3d'), wrap:false, foot:true, mode:'overview', kicker:'In-store mode', title:'Your cart route',
    before(host){ if(!guideOwns3d()) stop3d();   /* never tear down a running 3D guide */
      host.dataset.dx2 = '1'; host.classList.add('dx2'); host.setAttribute('aria-label', 'In-store map navigation'); }
  });
  /* put the original 3D card back, with one extra button to return to the 2D map */
  function ensure3dCard(){
    const wrap = document.getElementById('homeStoreNav3d'); if(!wrap) return null;
    if(wrap.dataset.dx2 === '0') return wrap;
    injectCss(); H.reset();
    wrap.dataset.dx2 = '0'; wrap.classList.remove('dx2'); wrap.setAttribute('aria-label', 'In-store 3D navigation');
    wrap.innerHTML = ORIG_HTML;
    const actions = wrap.querySelector('.home-store-nav-3d-actions'); if(actions) actions.insertBefore(to2dButton(), actions.firstChild);
    return wrap;
  }
  /* same name + same callers as before */
  window.renderHomeStoreNav3D = function(){
    if(viewMode === '3d' && typeof render3dHome === 'function'){
      if(typeof storeMode === 'undefined' || !storeMode) return;
      if(guideOpen()) return;   /* the guided screen owns the 3D scene; Home is redrawn when it closes */
      ensure3dCard();
      return render3dHome.apply(this, arguments);
    }
    return render2dHome();
  };
  async function render2dHome(){
    const wrap = document.getElementById('homeStoreNav3d');
    if(!wrap || typeof storeMode === 'undefined' || !storeMode) return;
    const items = cartArr();
    try{ await loadStoreNavMap(); }catch(e){}
    const cfg = STORE_NAV_MAP_CONFIG || {};
    if(!(cfg.mapDataUrl || navLayoutEls().length)){ wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    /* same stop list the rest of the app uses (kept so "Start" opens the existing guide) */
    const sample = !items.length;
    if(guideOpen()){ /* a guide is running: do not rebuild its stop list underneath it */ }
    else if(items.length){ STORE_NAV_ITEMS = items; STORE_NAV_STOPS = buildStoreNavRoute(items); }
    else {
      const aisles = navLayoutEls().filter(e => String(e.type || '') === 'aisle').sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0)).slice(0, 3);
      STORE_NAV_STOPS = aisles.map((e, i) => ({ loc:{ aisle:Number((String(e.label || '').match(/Aisle\s*(\d+)/i) || [])[1]) || i + 1, rack:1, shelf:1 }, items:[] }));
      if(navCheckoutPoint()) STORE_NAV_STOPS.push({ isCheckout:true, items:[] });
    }
    const stops = STORE_NAV_STOPS, name = cfg.mapName || 'Published store map';
    H.render(stops, 0, stops.length - 1, { sample, meta:sample ? `${name} · Add products to build your route` : `${name} · ${items.length} cart item${items.length === 1 ? '' : 's'}` });
  }

  /* ───────── GUIDED "Stop X of N" screen ───────── */
  const render3dGuide = window.renderStoreNavGuide;            /* the existing 3D guide renderer, untouched */
  const G = createNav('dx2g', { host:() => document.getElementById('storeNavGuideMap'), wrap:true, foot:false, mode:'follow', kicker:'Live store map', title:'Follow the blue line' });
  window.renderStoreNavGuide = function(){
    if(viewMode === '3d' && typeof render3dGuide === 'function'){
      G.reset();
      const r = render3dGuide.apply(this, arguments);
      injectCss();
      const actions = document.querySelector('#storeNavGuideMap .store-nav-3d-actions'); if(actions && !actions.querySelector('.dx2-to2d')) actions.insertBefore(to2dButton(), actions.firstChild);
      return r;
    }
    const stops = STORE_NAV_STOPS, idx = STORE_NAV_GUIDE_INDEX, cur = stops[idx];
    const title = document.getElementById('storeNavGuideTitle'), stp = document.getElementById('storeNavGuideStepTitle'), tx = document.getElementById('storeNavGuideStepText'), bar = document.getElementById('storeNavGuideProgress'), map = document.getElementById('storeNavGuideMap'), next = document.getElementById('storeNavGuideNext');
    if(!cur || !title || !stp || !tx || !bar || !map || !next) return;
    /* same wording as the existing guide */
    title.textContent = `Stop ${idx+1} of ${stops.length}`;
    stp.textContent = cur.isCheckout ? 'Checkout Counter' : (cur.loc ? `Aisle ${cur.loc.aisle} · Rack ${cur.loc.rack} · Shelf ${cur.loc.shelf}` : 'Location needs store update');
    tx.textContent = cur.isCheckout ? 'You’ve reached the final stop — complete your shopping at checkout.' : cur.loc ? `Pick ${(cur.items || []).map(x => `${x.name}${x.qty > 1 ? ' ×' + x.qty : ''}`).join(', ')}. ${idx < stops.length-1 ? 'Then continue to the next highlighted stop.' : 'You’ve reached the final stop — head to checkout.'}` : `Pick ${(cur.items || []).map(x => x.name).join(', ')} and ask the store team for the exact location.`;
    bar.style.width = `${Math.round((idx+1)/stops.length*100)}%`;
    next.textContent = idx < stops.length-1 ? 'Next stop →' : 'Finish route ✓';
    if(guideOwns3d()) stop3d();                                 /* switching 3D → 2D inside the guide */
    G.render(stops, idx, idx, { meta:`Stop ${idx+1} of ${stops.length} · ${cur.isCheckout ? 'Checkout counter' : (cur.loc ? `Aisle ${cur.loc.aisle} · Rack ${cur.loc.rack} · Shelf ${cur.loc.shelf}` : 'Store location')}` });
  };

  /* ───────── voice + 3D scene must end when navigation is exited ─────────
     The guided screen only hid itself on exit, so its 3D walker kept looping in
     the background and kept speaking. Shut everything down on every exit path. */
  function endGuide(){
    hushVoice();
    if(typeof STORE_NAV_3D !== 'undefined'){ STORE_NAV_3D.guideStarted = false; if(guideOwns3d()) stop3d(); }
    const map = document.getElementById('storeNavGuideMap'), had = !!(map && map.firstChild);
    if(map) map.innerHTML = '';
    G.reset();
    if(had && typeof storeMode !== 'undefined' && storeMode) setTimeout(() => { if(!guideOpen()) window.renderHomeStoreNav3D(); }, 30);
  }
  ['closeStoreNavGuide', 'closeStoreNavigation'].forEach(name => {
    const orig = window[name]; if(typeof orig !== 'function') return;
    window[name] = function(){ const r = orig.apply(this, arguments); try{ endGuide(); }catch(e){} return r; };
  });
  if(typeof window.setStoreMode === 'function'){
    const origMode = window.setStoreMode;
    window.setStoreMode = function(on){ const r = origMode.apply(this, arguments); if(!on){ try{ stop3d(); }catch(e){} } return r; };
  }
  window.addEventListener('pagehide', hushVoice);

  /* If Store Mode was already switched on before this file loaded, redraw. */
  try{ if(typeof storeMode !== 'undefined' && storeMode) window.renderHomeStoreNav3D(); }catch(e){}
})();
