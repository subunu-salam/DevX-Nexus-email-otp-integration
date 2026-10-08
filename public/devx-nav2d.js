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

  const FS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const cssFs = `
.store-nav-guide.dxfs{align-items:stretch;background:#0c1713}
.store-nav-guide.dxfs .store-nav-guide-card{max-width:none;width:100%;height:100%;border-radius:0;display:flex;flex-direction:column;box-sizing:border-box;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));animation:none}
.store-nav-guide.dxfs .store-nav-live-map{flex:1;min-height:0;margin-top:8px;padding:0;display:flex;flex-direction:column;overflow:hidden;border-radius:16px}
.store-nav-guide.dxfs .store-nav-3d-card,.store-nav-guide.dxfs .dx2-card{flex:1;min-height:0;display:flex;flex-direction:column;margin:0;border-radius:16px}
.store-nav-guide.dxfs .store-nav-3d-wrap,.store-nav-guide.dxfs .dx2-card .dx2-map{flex:1;min-height:0;height:auto!important}
.store-nav-guide.dxfs .store-nav-guide-step{margin-top:8px;padding:10px 12px}
.store-nav-guide.dxfs .store-nav-3d-note{padding-top:5px;padding-bottom:5px}
.store-nav-guide.dxfs .store-nav-3d-sub{display:none}
.store-nav-guide.dxfs .store-nav-3d-actions button,#homeStoreNav3d .home-store-nav-3d-actions button{padding:6px 7px}
#homeStoreNav3d.dxfs-home .home-store-nav-3d-sub{display:none}
#homeStoreNav3d.dxfs-home{position:fixed;inset:0;z-index:605;margin:0!important;border:0;border-radius:0!important;display:flex!important;flex-direction:column}
#homeStoreNav3d.dxfs-home .home-store-nav-3d-wrap,#homeStoreNav3d.dxfs-home .dx2-map{flex:1;min-height:0;height:auto!important}
#homeStoreNav3d.dxfs-home .dx2-steps.on{max-height:32vh}
#homeStoreNav3d.dxfs-home .dx2-head,#homeStoreNav3d.dxfs-home .home-store-nav-3d-head{padding-top:calc(10px + env(safe-area-inset-top,0px))}
.dxf-exit{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:7;border:0;border-radius:999px;padding:9px 14px;background:#202124;color:#fff;font:800 10px 'Montserrat',sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.4);cursor:pointer}
.dxf-fullbtn{display:grid!important;place-items:center;padding:5px 7px!important}
.dxf-fullbtn svg,.dx2-ctrl button svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.dx2-ctrl button[id$="Full"] svg{stroke:#3c4043}
.dxf-on .store-nav-3d-hud{display:none}
.dxf-layer{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden;font-family:'Montserrat',sans-serif}
.dxf-chip{position:absolute;left:0;top:0;display:flex;align-items:center;gap:4px;max-width:150px;padding:3px 7px;border:1px solid rgba(255,255,255,.22);border-radius:9px;background:rgba(9,24,17,.86);color:#eafff0;font:800 9px/1.2 'Montserrat',sans-serif;text-align:left;white-space:nowrap;pointer-events:none;box-shadow:0 3px 10px rgba(0,0,0,.35);will-change:transform}
.dxf-chip:after{content:'';position:absolute;left:50%;bottom:-4px;width:7px;height:7px;margin-left:-3.5px;transform:rotate(45deg);background:inherit;border-right:inherit;border-bottom:inherit}
.dxf-chip span{min-width:0;display:block;overflow:hidden}
.dxf-chip b{display:block;font-weight:900}
.dxf-chip u{text-decoration:none}.dxf-chip .s{display:none}
.dxf-chip em{display:block;font-style:normal;font-weight:700;font-size:7.5px;opacity:.78;overflow:hidden;text-overflow:ellipsis;max-width:118px}
.dxf-chip i{flex:none;width:15px;height:15px;border-radius:50%;background:#fff;color:#0f7b45;font:900 8.5px/15px 'Montserrat',sans-serif;text-align:center;font-style:normal}
.dxf-chip.min em{display:none}.dxf-chip.min .l{display:none}.dxf-chip.min .s{display:inline}
.dxf-chip.stop{background:rgba(15,123,69,.95);border-color:#7cffa8;color:#fff}
.dxf-chip.cur{background:#1a73e8;border-color:#fff;z-index:2}.dxf-chip.cur i{color:#1a73e8}
.dxf-chip.zone{background:rgba(9,24,17,.5);border-style:dashed;font-weight:700}
.dxf-chip.t-checkout{background:rgba(120,84,0,.92);border-color:#f6d98a}
.dxf-you{position:absolute;left:0;top:0;width:0;height:0;z-index:3;will-change:transform}
.dxf-you:before{content:'';position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 0 rgba(26,115,232,.55);animation:dxfPulse 1.8s infinite}
.dxf-you span{position:absolute;left:-16px;top:-27px;width:32px;text-align:center;padding:2px 0;border-radius:6px;background:#1a73e8;color:#fff;font:900 8px 'Montserrat',sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.35)}
@keyframes dxfPulse{0%{box-shadow:0 0 0 0 rgba(26,115,232,.55)}100%{box-shadow:0 0 0 16px rgba(26,115,232,0)}}
.dxf-mini{position:absolute;left:9px;bottom:9px;z-index:4;width:132px;padding:4px;border:1px solid rgba(255,255,255,.25);border-radius:10px;background:rgba(9,24,17,.9);box-shadow:0 6px 16px rgba(0,0,0,.4);cursor:pointer;display:none}
.dxf-mini.on{display:block}
.dxf-mini svg{display:block;width:100%;height:auto!important;border-radius:6px!important}
.dxf-allbtn.active{background:#27954e!important;border-color:#27954e!important;color:#fff!important}
.dxf-detail{position:absolute;left:8px;right:8px;bottom:8px;z-index:8;max-height:62%;display:flex;flex-direction:column;border-radius:16px;background:#fff;color:#202124;box-shadow:0 -6px 28px rgba(0,0,0,.4);overflow:hidden;font-family:'Montserrat',sans-serif;text-align:left}
.dxf-detail-head{display:flex;align-items:center;gap:10px;padding:11px 12px;border-bottom:1px solid #eceff1}
.dxf-detail-head>div{flex:1;min-width:0}
.dxf-detail-head b{display:block;font-size:14px;font-weight:900}
.dxf-detail-head span{display:block;font-size:9px;font-weight:700;color:#5f6368;margin-top:2px}
.dxf-detail-head button{width:30px;height:30px;border-radius:50%;border:1px solid #dadce0;background:#fff;color:#202124;font-size:17px;line-height:1;cursor:pointer;flex:none}
.dxf-detail-stops{padding:8px 12px;background:#e8f0fe;border-bottom:1px solid #d2e3fc}
.dxf-pick{display:flex;align-items:center;gap:9px;padding:3px 0}
.dxf-pick i{flex:none;width:20px;height:20px;border-radius:50%;background:#1a73e8;color:#fff;font:900 10px/20px 'Montserrat',sans-serif;text-align:center;font-style:normal}
.dxf-pick b{display:block;font-size:10.5px;font-weight:900}.dxf-pick span{display:block;font-size:8.5px;font-weight:700;color:#174ea6}
.dxf-detail-list{overflow:auto;-webkit-overflow-scrolling:touch;padding:0 12px 8px}
.dxf-rack{display:flex;justify-content:space-between;position:sticky;top:0;background:#fff;padding:8px 0 4px;font-size:8.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#188038}
.dxf-rack span{color:#80868b;letter-spacing:0;text-transform:none}
.dxf-prod{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f3f4}
.dxf-prod>div{flex:1;min-width:0}
.dxf-prod b{display:block;font-size:10px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dxf-prod span{display:block;font-size:8px;font-weight:600;color:#5f6368}
.dxf-prod em{flex:none;font-style:normal;font-size:8px;font-weight:800;color:#3c4043;background:#f1f3f4;border-radius:6px;padding:3px 6px}
.dxf-prod strong{flex:none;min-width:48px;text-align:right;font-size:9.5px;font-weight:900}
.dxf-prod.cart b{color:#1a73e8}.dxf-prod.cart em{background:#1a73e8;color:#fff}
.dxf-detail-empty{padding:14px 12px;font-size:10px;font-weight:700;color:#5f6368}
`;
  function injectCss(){ if(document.getElementById('dx2-style')) return; const s = document.createElement('style'); s.id = 'dx2-style'; s.textContent = css + cssFs; document.head.appendChild(s); }

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
            ${opt.full ? `<button type="button" id="${P}Full" aria-label="Full screen" title="Full screen">${FS_ICON}</button>` : ''}
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
      on('ZoomIn', () => zoomBy(.7)); on('ZoomOut', () => zoomBy(1/.7)); on('Full', () => toggleHomeFull());
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
      /* tap an aisle / rack on the map → product details */
      let down = null;
      svg.addEventListener('pointerdown', ev => { down = { x:ev.clientX, y:ev.clientY }; });
      svg.addEventListener('click', ev => {
        if(!st.vb || !st.route || (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 8)) return;
        const m = toMap(ev), px = m.x/st.route.W*100, py = m.y/st.route.D*100;
        const hit = navLayoutEls().filter(e => !['zone','section','text'].includes(String(e.type || '').toLowerCase()) && px >= Number(e.x) && px <= Number(e.x) + Number(e.w) && py >= Number(e.y) && py <= Number(e.y) + Number(e.h)).sort((a, b) => (Number(b.z) || 0) - (Number(a.z) || 0))[0];
        if(hit) openDetail(hit, document.getElementById(P + 'Map'));
      });
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
    host:() => document.getElementById('homeStoreNav3d'), wrap:false, foot:true, full:true, mode:'overview', kicker:'In-store mode', title:'Your cart route',
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
    const actions = wrap.querySelector('.home-store-nav-3d-actions'); if(actions){ actions.insertBefore(to2dButton(), actions.firstChild); const f = document.createElement('button'); f.type = 'button'; f.className = 'dxf-fullbtn'; f.title = 'Full screen'; f.setAttribute('aria-label', 'Full screen'); f.innerHTML = FS_ICON; f.addEventListener('click', () => toggleHomeFull()); actions.appendChild(f); }
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
  const G = createNav('dx2g', { host:() => document.getElementById('storeNavGuideMap'), wrap:true, foot:false, mode:'overview', kicker:'Live store map', title:'Follow the blue line' });
  window.renderStoreNavGuide = function(){
    injectCss(); document.getElementById('storeNavGuide')?.classList.add('dxfs');   /* guided navigation is a full-screen interface */
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
    closeDetail(); F.picked = false;
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


  /* ══════════════════════════════════════════════════════════════════════
     FULL-SCREEN NAVIGATION + RACK DETAILS  (3D view first, shared with 2D)
     • Guided navigation fills the whole screen; the Home card has a full-screen button.
     • 3D opens on an "Overview" camera fitted so every aisle and rack is in view,
       zoom-out is capped at that fit, and a mini-map appears whenever you zoom in.
     • A fixed-size "You" marker keeps your position readable at any zoom.
     • Every aisle carries a label chip (category, item count, your stops);
       tapping one lists the products on its racks and shelves.
     Everything here is an overlay on top of the existing 3D scene.
     ══════════════════════════════════════════════════════════════════════ */
  const F = { host:null, layer:null, chips:[], you:null, mini:null, miniYou:null, fit:null, ro:null, picked:false, lastDeclutter:0, idx:-1 };
  const S3 = () => (typeof STORE_NAV_3D !== 'undefined' ? STORE_NAV_3D : null);
  const live3d = () => { const S = S3(); return !!(S && S.renderer && S.camera && S.controls && S.canvas && S.canvas.isConnected && S.THREE); };
  const aisleNo = e => Number((String(e.label || '').match(/Aisle\s*(\d+)/i) || [])[1]) || Number(e.aisle) || 0;
  function aisleProducts(n){
    if(!n || typeof DB === 'undefined' || !Array.isArray(DB)) return [];
    return DB.map(p => ({ p, loc:navLocParts(p.loc) })).filter(x => x.loc && x.loc.aisle === n).sort((a, b) => a.loc.rack - b.loc.rack || a.loc.shelf - b.loc.shelf || String(a.p.name).localeCompare(String(b.p.name)));
  }
  function aisleCategory(n, prods){
    const a = typeof navAisleAnchor === 'function' ? navAisleAnchor(n) : null; if(a && a.category) return String(a.category);
    const c = {}; prods.forEach(x => { if(x.p.cat) c[x.p.cat] = (c[x.p.cat] || 0) + 1; });
    return Object.keys(c).sort((x, y) => c[y] - c[x])[0] || '';
  }
  const stopsInAisle = n => (STORE_NAV_STOPS || []).map((s, i) => ({ s, i })).filter(x => x.s && x.s.loc && Number(x.s.loc.aisle) === n);
  const TYPE_NOTE = { checkout:'Pay for your basket here.', entry:'Store entrance — your route starts here.', exit:'Store exit.', restroom:'Restrooms.', service:'Customer service desk.', 'service-desk':'Customer service desk.', 'customer-service':'Customer service desk.', stairs:'Stairs to the next floor.' };

  /* ── detail sheet (2D and 3D) ── */
  function closeDetail(){ document.querySelectorAll('.dxf-detail').forEach(n => n.remove()); }
  function openDetail(e, host){
    closeDetail(); if(!e || !host) return;
    const n = aisleNo(e), type = String(e.type || '').toLowerCase(), prods = aisleProducts(n), cat = n ? aisleCategory(n, prods) : '', stops = n ? stopsInAisle(n) : [];
    const inCart = new Set(); stops.forEach(x => (x.s.items || []).forEach(it => inCart.add(String(it.name))));
    const box = document.createElement('div'); box.className = 'dxf-detail'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Rack details');
    let html = `<div class="dxf-detail-head"><div><b>${E(e.label || e.type || 'Location')}</b><span>${E([cat, prods.length ? prods.length + ' product' + (prods.length === 1 ? '' : 's') : ''].filter(Boolean).join(' · ') || (TYPE_NOTE[type] || 'Store area'))}</span></div><button type="button" aria-label="Close">×</button></div>`;
    if(stops.length) html += `<div class="dxf-detail-stops">${stops.map(x => `<div class="dxf-pick"><i>${x.i + 1}</i><div><b>${E((x.s.items || []).map(it => it.name + (it.qty > 1 ? ' ×' + it.qty : '')).join(', ') || 'Stop ' + (x.i + 1))}</b><span>Stop ${x.i + 1} on your route · Rack ${x.s.loc.rack} · Shelf ${x.s.loc.shelf}</span></div></div>`).join('')}</div>`;
    if(prods.length){
      const racks = {}; prods.slice(0, 80).forEach(x => { (racks[x.loc.rack] = racks[x.loc.rack] || []).push(x); });
      html += `<div class="dxf-detail-list">${Object.keys(racks).sort((a, b) => a - b).map(r => `<div class="dxf-rack">Rack ${r}<span>${racks[r].length} item${racks[r].length === 1 ? '' : 's'}</span></div>${racks[r].map(x => `<div class="dxf-prod${inCart.has(String(x.p.name)) ? ' cart' : ''}"><div><b>${E(x.p.name)}</b><span>${E([x.p.brand, x.p.unit].filter(Boolean).join(' · '))}</span></div><em>Shelf ${x.loc.shelf}</em><strong>${x.p.price != null ? 'AED ' + E(x.p.price) : ''}</strong></div>`).join('')}`).join('')}${prods.length > 80 ? `<div class="dxf-rack">+${prods.length - 80} more</div>` : ''}</div>`;
    } else if(n) html += `<div class="dxf-detail-empty">No product locations are recorded for this aisle yet.</div>`;
    box.innerHTML = html;
    box.querySelector('button').addEventListener('click', closeDetail);
    ['pointerdown','wheel','touchstart'].forEach(t => box.addEventListener(t, ev => ev.stopPropagation(), { passive:true }));
    host.appendChild(box);
  }

  /* ── Home card: full-screen toggle ── */
  function toggleHomeFull(force){
    const wrap = document.getElementById('homeStoreNav3d'); if(!wrap) return;
    const on = force == null ? !wrap.classList.contains('dxfs-home') : !!force;
    injectCss(); wrap.classList.toggle('dxfs-home', on);
    document.body.style.overflow = on ? 'hidden' : '';
    let x = wrap.querySelector('.dxf-exit');
    if(on && !x){ x = document.createElement('button'); x.type = 'button'; x.className = 'dxf-exit'; x.textContent = '× Exit full screen'; x.addEventListener('click', () => toggleHomeFull(false)); wrap.appendChild(x); }
    if(!on && x) x.remove();
    setTimeout(() => { if(live3d()){ try{ resizeStoreNav3D(); }catch(e){} if(S3().view === 'all') fitAll(); } }, 60);
  }

  /* ── 3D: overview camera that always frames the whole store ── */
  function fitAll(){
    if(!live3d()) return; const S = S3(), T = S.THREE, cam = S.camera, { W, D } = dims();
    const host = S.canvas.parentElement, h = Math.max(200, host.clientHeight);
    const top = ((host.querySelector('.dx-turn') || {}).offsetHeight || 0) + 22, bot = 40;
    const yMax = 1 - 2*top/h, yMin = -1 + 2*bot/h, want = (yMin + yMax)/2;
    const elev = 60*Math.PI/180, sy = Math.sin(elev), sz = Math.cos(elev), v = new T.Vector3();
    const corners = []; [0, W].forEach(x => [0, 2.7].forEach(y => [0, D].forEach(z => corners.push([x, y, z]))));
    /* try the store both ways round and keep whichever shows it larger (portrait phones get the long side vertical) */
    const solve = rot => {
      const ext = rot ? W : D, hx = rot ? 1 : 0, hz = rot ? 0 : 1;
      const measure = (d, t) => { const cx = rot ? t : W/2, cz = rot ? D/2 : t; cam.position.set(cx + hx*sz*d, sy*d, cz + hz*sz*d); cam.lookAt(cx, 0, cz); cam.updateMatrixWorld(true); let x0 = 9, x1 = -9, y0 = 9, y1 = -9; corners.forEach(c => { v.set(c[0], c[1], c[2]).project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }); return { x0, x1, y0, y1 }; };
      let t = ext/2, d = Math.max(8, Math.max(W, D)*.5), m = null;
      for(let i = 0; i < 170; i++){
        for(let k = 0; k < 3; k++){ m = measure(d, t); const mid = (m.y0 + m.y1)/2, m2 = measure(d, t + .5), slope = ((m2.y0 + m2.y1)/2 - mid)/.5; if(Math.abs(slope) > 1e-5) t += Math.max(-ext, Math.min(ext, (want - mid)/slope)); }
        m = measure(d, t);
        if(m.x0 >= -.95 && m.x1 <= .95 && m.y0 >= yMin && m.y1 <= yMax) break;
        d *= 1.04;
      }
      return { rot, d, t, hx, hz };
    };
    const a = solve(false), b = solve(true), best = b.d < a.d*.9 ? b : a;
    const d = best.d, cx = best.rot ? best.t : W/2, cz = best.rot ? D/2 : best.t;
    S.controls.target.set(cx, 0, cz); S.controls.maxDistance = Math.max(d*1.12, Math.max(W, D)*1.3); S.controls.minDistance = 4;
    cam.position.set(cx + best.hx*sz*d, sy*d, cz + best.hz*sz*d); cam.lookAt(cx, 0, cz); S.controls.update();
    F.fit = { d, rot:best.rot };
    /* keep the mini-map the same way up as the overview */
    if(F.mini){ const sv = F.mini.querySelector('svg'), g = F.mini.querySelector('.dxf-mini-g'); if(sv && g){ sv.setAttribute('viewBox', best.rot ? `-1 -1 ${num(D + 2)} ${num(W + 2)}` : `-1 -1 ${num(W + 2)} ${num(D + 2)}`); if(best.rot) g.setAttribute('transform', `matrix(0 1 -1 0 ${num(D)} 0)`); else g.removeAttribute('transform'); F.mini.style.width = best.rot ? '96px' : '132px'; } }
  }
  window.storeNav3dAll = function(){ const S = S3(); if(!S) return; F.picked = true; S.view = 'all'; fitAll(); };
  ['storeNav3dIso', 'storeNav3dTop', 'storeNav3dFollow'].forEach(name => { const o = window[name]; if(typeof o === 'function') window[name] = function(){ F.picked = true; return o.apply(this, arguments); }; });

  /* ── 3D: overlay layer (aisle chips, "You" marker, mini-map) ── */
  function buildOverlay(idx){
    const S = S3(), host = S.canvas.parentElement, { W, D } = dims(), stops = STORE_NAV_STOPS || [];
    host.querySelectorAll('.dxf-layer,.dxf-mini').forEach(n => n.remove()); closeDetail();
    host.classList.add('dxf-on'); F.host = host; F.idx = idx;
    const layer = document.createElement('div'); layer.className = 'dxf-layer'; host.appendChild(layer); F.layer = layer; F.chips = [];
    /* the scene's own tiny sprite labels are replaced by readable chips */
    if(S.elGroups) S.elGroups.forEach(g => g.children.forEach(c => { if(c.isSprite) c.visible = false; }));
    const H3 = { aisle:2.4, rack:2.2, shelf:1.0, checkout:1.0, entry:2.2, exit:2.2, restroom:2.4, service:1.2, stairs:2 };
    navLayoutEls().forEach(e => {
      const type = String(e.type || '').toLowerCase(); if(type === 'text') return;
      const n = aisleNo(e), isAisle = type === 'aisle' && n > 0, sIn = isAisle ? stopsInAisle(n) : [], cur = sIn.some(x => x.i === idx);
      const prods = isAisle ? aisleProducts(n) : [], cat = isAisle ? aisleCategory(n, prods) : '';
      const b = document.createElement('div');
      b.className = 'dxf-chip' + (sIn.length ? ' stop' : '') + (cur ? ' cur' : '') + (type === 'zone' || type === 'section' ? ' zone' : '') + (isAisle ? '' : ' t-' + type);
      const label = String(e.label || e.type || ''), short = isAisle ? 'A' + n : label;
      let sub = '';
      if(sIn.length){ const first = sIn.find(x => x.i === idx) || sIn[0], names = (first.s.items || []).map(it => it.name); sub = (names[0] || 'Stop ' + (first.i + 1)) + (names.length > 1 ? ' +' + (names.length - 1) : '') + ` · R${first.s.loc.rack} S${first.s.loc.shelf}`; }
      else if(isAisle) sub = [cat, prods.length ? prods.length + ' items' : ''].filter(Boolean).join(' · ');
      b.innerHTML = `${sIn.map(x => `<i>${x.i + 1}</i>`).join('')}<span><b><u class="l">${E(label)}</u><u class="s">${E(short)}</u></b>${sub ? `<em>${E(sub)}</em>` : ''}</span>`;
      layer.appendChild(b);
      const chip = { b, e, type, x:(Number(e.x || 0) + Number(e.w || 0)/2)/100*W, y:(H3[type] || (type === 'zone' || type === 'section' ? .1 : 1.1)) + .35, z:(Number(e.y || 0) + Number(e.h || 0)/2)/100*D, prio:cur ? 3 : (sIn.length ? 2 : (isAisle ? 1 : 0)), size:{} };
      chip.size.full = [b.offsetWidth, b.offsetHeight]; b.classList.add('min'); chip.size.min = [b.offsetWidth, b.offsetHeight];
      F.chips.push(chip);
    });
    F.chips.sort((a, b) => b.prio - a.prio);
    const you = document.createElement('div'); you.className = 'dxf-you'; you.innerHTML = '<span>You</span>'; layer.appendChild(you); F.you = you;
    /* mini-map: the whole store, always */
    const mini = document.createElement('button'); mini.type = 'button'; mini.className = 'dxf-mini'; mini.title = 'Show the whole store'; mini.setAttribute('aria-label', 'Mini-map — tap to show the whole store');
    const fill = { aisle:'#cfe9db', rack:'#cfe9db', shelf:'#dbeee3', checkout:'#f6d98a', entry:'#7cffa8', exit:'#c9b5f5' };
    const rects = navLayoutEls().filter(e => !['zone','section','text'].includes(String(e.type || '').toLowerCase())).map(e => { const t = String(e.type || '').toLowerCase(), hit = t === 'aisle' && stopsInAisle(aisleNo(e)).some(x => x.i === idx || idx < 0); return `<rect x="${num(Number(e.x || 0)/100*W)}" y="${num(Number(e.y || 0)/100*D)}" width="${num(Math.max(.4, Number(e.w || 1)/100*W))}" height="${num(Math.max(.4, Number(e.h || 1)/100*D))}" rx=".2" fill="${hit ? '#4da3ff' : (fill[t] || '#b9c7bf')}"/>`; }).join('');
    let line = ''; try{ const pts = idx >= 0 ? navGuideSegmentPoints(stops, idx) : navBuildPathPoints(stops, -1); line = pts.map(p => num(p.x/100*W) + ',' + num(p.y/100*D)).join(' '); }catch(err){}
    mini.innerHTML = `<svg viewBox="-1 -1 ${num(W + 2)} ${num(D + 2)}" aria-hidden="true"><g class="dxf-mini-g"><rect x="0" y="0" width="${W}" height="${D}" rx=".6" fill="#12241b" stroke="#3a5a49" stroke-width=".3"/>${rects}<polyline points="${line}" fill="none" stroke="#19b86a" stroke-width=".7" stroke-linecap="round" stroke-linejoin="round"/><circle class="dxf-mini-you" r="1.5" fill="#1a73e8" stroke="#fff" stroke-width=".5"/></g></svg>`;
    mini.addEventListener('click', ev => { ev.stopPropagation(); window.storeNav3dAll(); });
    host.appendChild(mini); F.mini = mini; F.miniYou = mini.querySelector('.dxf-mini-you');
    /* view buttons: add "Overview" (whole store) to both 3D headers */
    const card = host.closest('.store-nav-3d-card, #homeStoreNav3d'), actions = card && card.querySelector('.store-nav-3d-actions, .home-store-nav-3d-actions');
    if(actions && !actions.querySelector('.dxf-allbtn')){ const a = document.createElement('button'); a.type = 'button'; a.className = 'dxf-allbtn'; a.textContent = 'Overview'; a.addEventListener('click', () => window.storeNav3dAll()); const ref = actions.querySelector('.dx2-to2d'); actions.insertBefore(a, ref ? ref.nextSibling : actions.firstChild); }
    const note = card && card.querySelector('.store-nav-3d-note, .home-store-nav-3d-footer'); if(note && note.firstChild && note.firstChild.nodeType === 3) note.firstChild.textContent = 'Tap an aisle for products · pinch to zoom · ';
  }
  /* a tap on a label chip, or on the aisle / rack itself, opens its product details */
  function tap3d(ev){
    if(!live3d() || !F.host) return; const S = S3(), T = S.THREE, r = F.host.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, { W, D } = dims(), v = new T.Vector3();
    let hit = F.chips.find(c => c.mode && c.type !== 'zone' && c.type !== 'section' && Math.abs(x - c.sx) <= c.size[c.mode][0]/2 + 5 && y <= c.sy + 6 && y >= c.sy - c.size[c.mode][1] - 6);
    if(!hit){
      let best = 1e9;
      F.chips.forEach(c => { if(c.type === 'zone' || c.type === 'section') return; const e = c.e, x0 = Number(e.x || 0)/100*W, z0 = Number(e.y || 0)/100*D, x1 = x0 + Number(e.w || 1)/100*W, z1 = z0 + Number(e.h || 1)/100*D; let a = 1e9, b = -1e9, t = 1e9, u = -1e9; [x0, x1].forEach(px => [0, c.y].forEach(py => [z0, z1].forEach(pz => { v.set(px, py, pz).project(S.camera); const sx = (v.x + 1)/2*r.width, sy = (1 - v.y)/2*r.height; a = Math.min(a, sx); b = Math.max(b, sx); t = Math.min(t, sy); u = Math.max(u, sy); }))); if(x >= a && x <= b && y >= t && y <= u){ const area = (b - a)*(u - t); if(area < best){ best = area; hit = c; } } });
    }
    if(hit) openDetail(hit.e, F.host);
  }
  function clampTarget(){
    const S = S3(); if(!S || !S.controls || !S.camera || F.clamping) return; const { W, D } = dims(), t = S.controls.target;
    const nx = Math.max(0, Math.min(W, t.x)), nz = Math.max(0, Math.min(D, t.z)); if(nx === t.x && nz === t.z) return;
    F.clamping = true; S.camera.position.x += nx - t.x; S.camera.position.z += nz - t.z; t.x = nx; t.z = nz; F.clamping = false;
  }
  if(typeof window.mountStoreNav3D === 'function'){
    const mount0 = window.mountStoreNav3D;
    window.mountStoreNav3D = async function(idx){
      const S = S3(); if(S && !F.picked) S.view = 'all';                 /* default: whole store in view */
      const r = await mount0.apply(this, arguments);
      try{
        if(live3d()){
          injectCss();
          const S2 = S3(), host = S2.canvas.parentElement;
          if(F.ctl !== S2.controls){ F.ctl = S2.controls; S2.controls.addEventListener('change', clampTarget); }
          if(F.ro) try{ F.ro.disconnect(); }catch(e){}
          if('ResizeObserver' in window){ let first = true; F.ro = new ResizeObserver(() => { if(first){ first = false; return; } if(!live3d()) return; try{ resizeStoreNav3D(); }catch(e){} if(S3().view === 'all') fitAll(); }); F.ro.observe(host); }
          if(F.tapCanvas !== S2.canvas){ F.tapCanvas = S2.canvas; let dn = null;
            S2.canvas.addEventListener('pointerdown', ev => { dn = { x:ev.clientX, y:ev.clientY, t:performance.now() }; });
            S2.canvas.addEventListener('pointerup', ev => { if(!dn || Math.hypot(ev.clientX - dn.x, ev.clientY - dn.y) > 8 || performance.now() - dn.t > 600) return; dn = null; tap3d(ev); }); }
          buildOverlay(typeof idx === 'number' ? idx : -1);
          fitAll(); if(S2.view !== 'all'){ const keep = S2.view; try{ ({ iso:window.storeNav3dIso, top:window.storeNav3dTop, follow:window.storeNav3dFollow }[keep] || (() => {}))(); }catch(e){} }
          if(!F.raf) F.raf = requestAnimationFrame(overlayFrame);
        }
      }catch(err){ console.warn('[DevX nav] overlay', err); }
      return r;
    };
  }
  function overlayFrame(now){
    F.raf = requestAnimationFrame(overlayFrame);
    if(!live3d() || !F.layer || !F.layer.isConnected) return;
    const S = S3(), T = S.THREE, cam = S.camera, host = F.host, w = host.clientWidth, h = host.clientHeight, v = F.v || (F.v = new T.Vector3());
    const proj = (x, y, z) => { v.set(x, y, z).project(cam); return { x:(v.x + 1)/2*w, y:(1 - v.y)/2*h, ok:v.z < 1 && v.z > -1 }; };
    const person = S.nav && S.nav.person;
    if(person && F.you){ const p = proj(person.position.x, 2.05, person.position.z); F.you.style.display = p.ok && S.view !== 'follow' ? '' : 'none'; F.you.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`; if(F.miniYou){ F.miniYou.setAttribute('cx', num(person.position.x)); F.miniYou.setAttribute('cy', num(person.position.z)); } }
    else if(F.you) F.you.style.display = 'none';
    const declutter = now - F.lastDeclutter > 220; if(declutter) F.lastDeclutter = now;
    const placed = declutter ? [] : null, top = ((host.querySelector('.dx-turn') || {}).offsetHeight || 0) + 10;
    F.chips.forEach(c => {
      const p = proj(c.x, c.y, c.z); c.sx = p.x; c.sy = p.y;
      if(declutter){
        let mode = '';
        if(p.ok && p.x > -40 && p.x < w + 40 && p.y > top && p.y < h + 10){
          for(const m of ['full', 'min']){ const sz = c.size[m], r = [p.x - sz[0]/2 - 2, p.y - sz[1] - 2, p.x + sz[0]/2 + 2, p.y + 2]; if(!placed.some(q => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])){ mode = m; placed.push(r); break; } }
          if(!mode && c.prio >= 2){ mode = 'min'; }
        }
        if(c.mode !== mode){ c.mode = mode; c.b.style.display = mode ? '' : 'none'; c.b.classList.toggle('min', mode === 'min'); }
      }
      if(c.mode) c.b.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-100%)`;
    });
    if(declutter){
      const dist = cam.position.distanceTo(S.controls.target), zoomedIn = S.view === 'follow' || (F.fit && dist < F.fit.d*.82);
      if(F.mini) F.mini.classList.toggle('on', !!zoomedIn);
      document.querySelectorAll('.dxf-allbtn').forEach(b => b.classList.toggle('active', S.view === 'all'));
      if(S.view === 'all') ['storeNav3dIsoBtn','storeNav3dTopBtn','storeNav3dFollowBtn','homeStoreNav3dIsoBtn','homeStoreNav3dTopBtn'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    }
  }

  /* If Store Mode was already switched on before this file loaded, redraw. */
  try{ if(typeof storeMode !== 'undefined' && storeMode) window.renderHomeStoreNav3D(); }catch(e){}
})();
