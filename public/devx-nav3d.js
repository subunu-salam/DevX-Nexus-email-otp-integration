/* DevX NeXus — customer 3D navigation, realistic edition (additive).
   Loaded after the main app script. It re-declares only the 3D-navigation
   functions (same names, same call signatures), so every existing caller keeps
   working. Route data still comes from the published Admin map via
   navBuildPathPoints / navGuideSegmentPoints / navStopPoint. */
(function(){
  const K = window.DevXStore3D;
  if(!K || typeof STORE_NAV_3D === 'undefined') return;
  const S = STORE_NAV_3D;
  S.view = S.view || 'iso';
  S.nav = null;

  /* ── Path smoothing: string-pull the A* staircase into natural walking lines ── */
  function losFree(a, b, obs){
    const n = Math.max(2, Math.ceil(Math.hypot(b.x-a.x, b.y-a.y)/0.6));
    for(let i=1;i<n;i++){ const t = i/n; if(navCellBlocked(a.x+(b.x-a.x)*t, a.y+(b.y-a.y)*t, obs)) return false; }
    return true;
  }
  function smoothPct(points){
    if(!points || points.length < 3) return points || [];
    const obs = navRouteObstacles(), out = [points[0]]; let i = 0;
    while(i < points.length-1){
      let j = points.length-1;
      while(j > i+1 && !losFree(points[i], points[j], obs)) j--;
      out.push(points[j]); i = j;
    }
    return out;
  }
  function to3(pts){ return (pts||[]).map(p => { const q = storeNav3dPoint(p); return { x:q.x, z:q.z, px:p.x, py:p.y }; }); }

  /* ── Landmarks & turn instructions ── */
  function elLabel(e){ return String(e.label || e.type || '').trim(); }
  function nearestLandmark(p){
    let best = null, bd = 9;
    navLayoutEls().forEach(e => {
      if(!['aisle','rack','checkout','service','restroom','entry','exit'].includes(String(e.type||''))) return;
      const x = Number(e.x)||0, y = Number(e.y)||0, w = Number(e.w)||1, h = Number(e.h)||1;
      const dx = Math.max(x - p.px, 0, p.px - (x+w)), dy = Math.max(y - p.py, 0, p.py - (y+h)), d = Math.hypot(dx, dy);
      if(d < bd){ bd = d; best = e; }
    });
    return best ? elLabel(best) : '';
  }
  function stopName(stop){
    if(!stop) return 'your stop';
    if(stop.isCheckout) return 'the checkout';
    return stop.loc ? `Aisle ${stop.loc.aisle}` : 'your stop';
  }
  function buildManeuvers(poly, stop, destEl){
    const m = [], P = poly.pts;
    if(poly.seg.length){
      const lm = nearestLandmark(P[P.length-1]);
      m.push({ at:0, type:'straight', text:`Head ${poly.total > 4 ? 'straight' : 'forward'} towards ${stopName(stop)}${lm && !stop?.isCheckout ? '' : ''}` });
    }
    for(let i=1;i<P.length-1;i++){
      const a = poly.seg[i-1], b = poly.seg[i]; if(!a || !b) continue;
      const cross = -a.dz*b.dx + a.dx*b.dz, dot = a.dx*b.dx + a.dz*b.dz, ang = Math.acos(Math.max(-1, Math.min(1, dot)))*180/Math.PI;
      if(ang < 22) continue;
      const side = cross > 0 ? 'right' : 'left', slight = ang < 60, uturn = ang > 150;
      const lm = nearestLandmark(P[i]);
      const type = uturn ? 'uturn' : (slight ? 'slight-'+side : side);
      const verb = uturn ? 'Make a U-turn' : (slight ? `Bear ${side}` : `Turn ${side}`);
      m.push({ at:b.s0, type, text: lm ? `${verb} at ${lm}` : verb });
    }
    let arrive = stop?.isCheckout ? 'Arrive at the checkout counter' : (stop?.loc ? `Arrive at Aisle ${stop.loc.aisle} · Rack ${stop.loc.rack} · Shelf ${stop.loc.shelf}` : 'Arrive at your stop');
    if(destEl && poly.seg.length && !stop?.isCheckout){
      const last = poly.seg[poly.seg.length-1], end = poly.pts[poly.pts.length-1];
      const c = storeNav3dPoint({ x:(Number(destEl.x)||0)+(Number(destEl.w)||0)/2, y:(Number(destEl.y)||0)+(Number(destEl.h)||0)/2 });
      const vx = c.x - end.x, vz = c.z - end.z, cr = -last.dz*vx + last.dx*vz, fw = last.dx*vx + last.dz*vz;
      arrive += Math.abs(fw) > Math.abs(cr) ? ' — straight ahead' : (cr > 0 ? ' — on your right' : ' — on your left');
    }
    m.push({ at:poly.total, type:'arrive', text:arrive });
    return m;
  }

  const ICONS = {
    straight:'<path d="M12 21V5M6 11l6-6 6 6"/>',
    left:'<path d="M17 21v-8a4 4 0 0 0-4-4H5M9 5L5 9l4 4"/>',
    right:'<path d="M7 21v-8a4 4 0 0 1 4-4h8M15 5l4 4-4 4"/>',
    'slight-left':'<path d="M15 21v-6l-7-7M8 14V8h6"/>',
    'slight-right':'<path d="M9 21v-6l7-7M16 14V8h-6"/>',
    uturn:'<path d="M8 21V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4"/>',
    arrive:'<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/>'
  };
  const icon = t => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t]||ICONS.straight}</svg>`;
  const fmtM = m => m < 1 ? 'Now' : `${Math.round(m)} m`;

  /* ── HUD overlay (Google-Maps-style instruction banner) ── */
  function ensureHud(canvas, compact){
    const host = canvas.parentElement; if(!host) return null;
    host.classList.add('dx-nav-host');
    let el = host.querySelector('.dx-turn');
    if(!el){
      el = document.createElement('div'); el.className = 'dx-turn' + (compact ? ' compact' : '');
      el.innerHTML = `<div class="dx-turn-main"><div class="dx-turn-ic"></div><div class="dx-turn-copy"><div class="dx-turn-dist"></div><div class="dx-turn-text"></div></div><button type="button" class="dx-turn-voice" aria-label="Voice guidance" title="Voice guidance">🔇</button></div><div class="dx-turn-then"></div>`;
      host.appendChild(el);
      el.querySelector('.dx-turn-voice').addEventListener('click', ev => { ev.stopPropagation(); S.voice = !S.voice; try{ localStorage.setItem('devx-nav-voice', S.voice ? '1' : '0'); }catch(e){} syncVoiceBtn(el); if(!S.voice) try{ speechSynthesis.cancel(); }catch(e){} else if(S.nav) S.nav.spoken = -1; });
      let eta = host.querySelector('.dx-eta'); if(!eta){ eta = document.createElement('div'); eta.className = 'dx-eta'; host.appendChild(eta); }
    }
    syncVoiceBtn(el);
    return el;
  }
  function syncVoiceBtn(el){ const b = el && el.querySelector('.dx-turn-voice'); if(b){ b.textContent = S.voice ? '🔊' : '🔇'; b.classList.toggle('on', !!S.voice); } }
  try{ S.voice = localStorage.getItem('devx-nav-voice') === '1'; }catch(e){ S.voice = false; }
  function speak(text){ if(!S.voice || !('speechSynthesis' in window)) return; try{ speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text.replace(/·/g, ',')); u.rate = 1.02; speechSynthesis.speak(u); }catch(e){} }

  function updateHud(nav, s, arrived){
    const el = nav.hud; if(!el) return;
    const ms = nav.maneuvers; let k = ms.findIndex(q => q.at > s + .35); if(k < 0) k = ms.length-1;
    const cur = arrived ? ms[ms.length-1] : ms[k], nxt = arrived ? null : ms[k+1];
    const dist = Math.max(0, cur.at - s);
    const key = (arrived ? 'A' : k) + '|' + cur.type;
    if(nav.hudKey !== key){
      nav.hudKey = key;
      el.querySelector('.dx-turn-ic').innerHTML = icon(cur.type);
      el.querySelector('.dx-turn-text').textContent = arrived ? (nav.pickText || cur.text) : cur.text;
      el.classList.toggle('arrived', !!arrived);
      const then = el.querySelector('.dx-turn-then');
      if(nxt){ then.innerHTML = `<span>Then</span>${icon(nxt.type)}<b>${esc(nxt.text)}</b>`; then.style.display = 'flex'; } else then.style.display = 'none';
      if(nav.spoken !== key){ nav.spoken = key; speak(arrived ? (nav.pickText || cur.text) : (dist > 1.5 ? `In ${Math.round(dist)} metres, ${cur.text}` : cur.text)); }
    }
    el.querySelector('.dx-turn-dist').textContent = arrived ? 'You have arrived' : (cur.type === 'straight' && k === 0 && s < .5 ? `${Math.round(nav.poly.total)} m to go` : fmtM(dist));
    const eta = el.parentElement.querySelector('.dx-eta');
    if(eta){ const left = Math.max(0, nav.poly.total - s), sec = Math.max(0, Math.round(left/1.2)); eta.innerHTML = arrived ? `<b>●</b> Arrived · pick your items` : `<b>${Math.round(left)} m</b> · ~${sec < 60 ? sec + ' sec' : Math.round(sec/60) + ' min'} walk`; }
  }

  /* ── Scene build (same inputs as before, realistic output) ── */
  window.storeNav3dBuild = function(idx){
    const T = S.THREE, els = navLayoutEls(), { W, D } = storeNav3dDims();
    storeNav3dClear(); S.nav = null; S.elGroups = new Map();
    const keep = o => { S.scene.add(o); S.objects.push(o); return o; };
    S.scene.background = new T.Color(0x0e1a15);
    S.scene.fog = new T.Fog(0x0e1a15, Math.max(W, D)*2.2, Math.max(W, D)*4.5);
    keep(K.buildShell(T, W, D));
    keep(K.lights(T, W, D));
    const stops = STORE_NAV_STOPS || [];
    const saleSet = new Set(); els.filter(e => e.type === 'aisle').forEach((e, i) => { if(K.hash(e.id || e.label || i) % 3 === 0) saleSet.add(e); });

    els.slice().sort((a,b) => (Number(a.z)||0) - (Number(b.z)||0)).forEach(e => {
      const x = Number(e.x||0)/100*W, y = Number(e.y||0)/100*D, w = Math.max(.5, Number(e.w||1)/100*W), d = Math.max(.5, Number(e.h||1)/100*D);
      let height = { aisle:2.4, rack:2.2, shelf:1.0, zone:.08, entry:2.2, exit:2.2, checkout:1.0, restroom:2.4, service:1.2, stairs:2, text:.08 }[e.type] || 1.1;
      const color = /^#[0-9a-f]{6}$/i.test(e.color||'') ? e.color : '#d9f3e2';
      const g = new T.Group(); g.position.set(x + w/2, height/2, y + d/2); g.rotation.y = (Number(e.rotation)||0)*Math.PI/180;
      if(e.type === 'aisle' || e.type === 'rack' || e.type === 'shelf'){
        g.add(K.buildGondola(T, { w, h:height, d, seed:e.id || e.label, accent:color, sale:saleSet.has(e) }));
      } else if(e.type === 'zone' || e.type === 'text'){
        const z = new T.Mesh(new T.BoxGeometry(w, .03, d), new T.MeshStandardMaterial({ color:new T.Color(color), transparent:true, opacity:.35, roughness:.9 }));
        z.position.y = -height/2 + .02; g.add(z);
      } else if(e.type === 'checkout'){
        const base = new T.Mesh(new T.BoxGeometry(w, height*.9, d*.8), K.std(T, '#e9edf0', .5, .1)); base.position.y = -height*.05; base.castShadow = true; g.add(base);
        const belt = new T.Mesh(new T.BoxGeometry(w*.7, .04, d*.5), K.std(T, '#1d2126', .8, .1)); belt.position.set(-w*.1, height*.42, 0); g.add(belt);
        const reg = new T.Mesh(new T.BoxGeometry(Math.min(.5, w*.2), .32, .3), K.std(T, '#2a2f36', .4, .4)); reg.position.set(w*.36, height*.42 + .18, 0); g.add(reg);
        const lane = new T.Mesh(new T.CylinderGeometry(.04, .04, 1.2, 8), K.std(T, '#27954e', .4, .3)); lane.position.set(w/2 - .1, height*.2 + .6, -d*.3); g.add(lane);
        const lamp = new T.Mesh(new T.SphereGeometry(.1, 12, 10), new T.MeshBasicMaterial({ color:0x7cffa8 })); lamp.position.set(w/2 - .1, height*.2 + 1.25, -d*.3); g.add(lamp);
      } else if(e.type === 'entry' || e.type === 'exit'){
        const c = e.type === 'entry' ? 0x27954e : 0x8b5cf6;
        const frame = K.std(T, e.type === 'entry' ? '#27954e' : '#8b5cf6', .5, .2);
        const l = new T.Mesh(new T.BoxGeometry(.12, height, .12), frame), r = l.clone(), top = new T.Mesh(new T.BoxGeometry(Math.max(w, d), .14, .14), frame);
        const span = Math.max(w, d)/2; if(w >= d){ l.position.x = -span; r.position.x = span; } else { l.position.z = -span; r.position.z = span; top.rotation.y = Math.PI/2; }
        top.position.y = height/2; g.add(l, r, top);
        const glass = new T.Mesh(new T.BoxGeometry(w >= d ? w : .04, height*.95, w >= d ? .04 : d), new T.MeshStandardMaterial({ color:0xbfe8ff, transparent:true, opacity:.22, roughness:.05, metalness:.1 }));
        g.add(glass);
        const mat = new T.Mesh(new T.BoxGeometry(w, .02, d), new T.MeshStandardMaterial({ color:c, roughness:.9 })); mat.position.y = -height/2 + .02; g.add(mat);
      } else {
        const body = new T.Mesh(new T.BoxGeometry(w, height, d), K.std(T, color, .7, .05)); body.castShadow = true; body.receiveShadow = true; g.add(body);
      }
      const label = storeNav3dLabel(e.label || e.type, e.type === 'entry' ? '#7CFFA8' : '#eafff0'); label.position.set(0, height/2 + .9, 0); g.add(label);
      keep(g); S.elGroups.set(e, g);
    });
    storeNav3dRoute(idx);
    storeNav3dApplyView();
  };

  function storeNav3dRoute(idx){
    const T = S.THREE, stops = STORE_NAV_STOPS || [];
    const cfg = STORE_NAV_MAP_CONFIG || {};
    const fullPct = smoothPct(navBuildPathPoints(stops, idx));
    const legPct = idx >= 0 ? smoothPct(navGuideSegmentPoints(stops, idx)) : fullPct;
    const full = K.polyline(to3(fullPct)), leg = K.polyline(to3(legPct));
    const add = o => { S.scene.add(o); S.routeDots.push(o); return o; };

    if(idx >= 0 && full.total > leg.total + .5){ const r = K.ribbon(T, full, .34, 0x9fd9b8, .045, .55); add(r); }
    const border = K.ribbon(T, leg, .78, 0x0b5c32, .05); add(border);
    const main = K.ribbon(T, leg, .56, 0x19b86a, .06); add(main);

    /* moving chevrons */
    const spacing = 1.05, count = Math.max(0, Math.floor(leg.total/spacing));
    let chev = null;
    if(count){ chev = new T.InstancedMesh(K.chevronGeometry(T, .38), new T.MeshBasicMaterial({ color:0xffffff, side:T.DoubleSide, transparent:true, opacity:.95, depthWrite:false }), count); chev.renderOrder = 8; add(chev); }

    /* stop markers along the full route */
    STORE_NAV_STOPS.forEach((stop, i) => {
      const p = navStopPoint(stop, i ? (navStopPoint(STORE_NAV_STOPS[i-1]) || { x:50, y:94 }) : (cfg.entry || { x:50, y:94 })); if(!p) return;
      const q = storeNav3dPoint(p), done = idx >= 0 && i < idx, active = i === idx;
      if(active) return;
      const disc = new T.Mesh(new T.CylinderGeometry(.26, .26, .06, 24), new T.MeshStandardMaterial({ color:done ? 0x9adab7 : 0xffffff, emissive:done ? 0x0c5c31 : 0x000000, emissiveIntensity:.3 }));
      disc.position.set(q.x, .08, q.z); add(disc);
      const lab = storeNav3dLabel(String(i+1), done ? '#9adab7' : '#ffffff'); lab.scale.set(1.2, .5, 1); lab.position.set(q.x, .7, q.z); add(lab);
    });

    /* destination pin + pulse ring */
    const end = leg.pts[leg.pts.length-1] || { x:storeNav3dDims().W/2, z:storeNav3dDims().D*.86 };
    const pin = new T.Group(); pin.position.set(end.x, 0, end.z);
    const pinMat = new T.MeshStandardMaterial({ color:0x12a75b, emissive:0x0c5c31, emissiveIntensity:.55, roughness:.35 });
    const head = new T.Mesh(new T.SphereGeometry(.32, 20, 16), pinMat); head.position.y = 1.35;
    const tip = new T.Mesh(new T.ConeGeometry(.32, .7, 20), pinMat); tip.rotation.x = Math.PI; tip.position.y = .95;
    const dot = new T.Mesh(new T.SphereGeometry(.12, 12, 10), new T.MeshBasicMaterial({ color:0xffffff })); dot.position.set(0, 1.38, .26);
    const bob = new T.Group(); bob.add(head, tip, dot); pin.add(bob);
    const ring = new T.Mesh(new T.RingGeometry(.35, .5, 40), new T.MeshBasicMaterial({ color:0x19b86a, transparent:true, opacity:.8, side:T.DoubleSide, depthWrite:false })); ring.rotation.x = -Math.PI/2; ring.position.y = .08; pin.add(ring);
    add(pin);

    /* highlight the exact rack / shelf level on the destination gondola */
    const stop = idx >= 0 ? stops[idx] : null;
    let destEl = null, glow = null;
    if(stop && stop.loc){
      destEl = navAisleElFor(Number(stop.loc.aisle) || 0);
      const g = destEl && S.elGroups.get(destEl), gon = g && g.children.find(c => c.userData && c.userData.gondola);
      if(gon){
        const info = gon.userData.gondolaInfo, lv = info.levels, level = Math.min(lv.length-1, Math.max(0, (Number(stop.loc.shelf) || 1) - 1));
        const racks = Math.max(1, Math.round(info.L/1.6)), rIdx = Math.min(racks-1, Math.max(0, (Number(stop.loc.rack)||1) - 1));
        const seg = info.L/racks, cx = -info.L/2 + seg*(rIdx + .5);
        const local = new T.Vector3(); g.updateMatrixWorld(true); gon.updateMatrixWorld(true);
        const endLocal = info.inner.worldToLocal(new T.Vector3(end.x, 0, end.z));
        const side = info.double ? (endLocal.z >= 0 ? 1 : -1) : 1;
        const zc = info.double ? side*(.03 + info.sd/2) : info.panelZ + .03 + info.sd/2;
        glow = new T.Mesh(new T.BoxGeometry(seg*.92, (lv[1]-lv[0] || .45)*.8, info.sd + .06), new T.MeshBasicMaterial({ color:0x2bff8a, transparent:true, opacity:.28, depthWrite:false }));
        glow.position.set(cx, lv[level], zc);
        info.inner.add(glow); S.routeDots.push({ parent:null, _detach:() => info.inner.remove(glow) });
        const tag = storeNav3dLabel(`Shelf ${stop.loc.shelf} · Rack ${stop.loc.rack}`, '#7CFFA8'); tag.scale.set(3.4, .66, 1);
        glow.getWorldPosition(local); tag.position.set(local.x, local.y + .75, local.z); add(tag);
      }
    }

    /* walker */
    const person = K.makePerson(T); const st = leg.at(0); person.position.set(st.x, 0, st.z); person.rotation.y = Math.atan2(st.dx, st.dz);
    S.scene.add(person); S.walkers.push(person);

    const pickText = stop ? (stop.isCheckout ? 'You have arrived at the checkout — pay and you are done' : `Pick ${stop.items.map(x => x.name + (x.qty > 1 ? ' ×' + x.qty : '')).join(', ')} from Shelf ${stop.loc ? stop.loc.shelf : ''}`.trim()) : 'You have reached the end of your cart route';
    const compact = S.canvas && S.canvas.id !== 'storeNav3dCanvas';
    S.nav = { poly:leg, chev, spacing, count, person, pin:bob, ring, glow, s:0, phase:0, pause:0, maneuvers:buildManeuvers(leg, stop, destEl), pickText, hud:ensureHud(S.canvas, compact), hudKey:'', spoken:null, t0:performance.now() };
    updateHud(S.nav, 0, false);
  }

  /* routeDots may contain detach hooks for meshes parented inside gondolas */
  window.storeNav3dClear = function(){
    if(!S.scene) return;
    S.objects.forEach(o => S.scene.remove(o));
    S.routeDots.forEach(o => { if(o && o._detach) o._detach(); else S.scene.remove(o); });
    S.walkers.forEach(o => S.scene.remove(o));
    S.objects = []; S.routeDots = []; S.walkers = []; S.route = null;
  };

  /* ── Per-frame animation ── */
  const WALK_SPEED = 1.7, PAUSE = 2.6;
  function tick(dt, now){
    const n = S.nav; if(!n) return;
    const T = S.THREE, arrivedPhase = n.s >= n.poly.total - 1e-3;
    if(arrivedPhase){ n.pause += dt; if(n.pause > PAUSE){ n.s = 0; n.pause = 0; } }
    else { n.s = Math.min(n.poly.total, n.s + WALK_SPEED*dt); n.phase += dt*8.5; }
    const p = n.poly.at(n.s), moving = !arrivedPhase && n.poly.total > 0;
    n.person.position.x = p.x; n.person.position.z = p.z;
    const yaw = Math.atan2(p.dx, p.dz); let dy = yaw - n.person.rotation.y; while(dy > Math.PI) dy -= Math.PI*2; while(dy < -Math.PI) dy += Math.PI*2; n.person.rotation.y += dy*Math.min(1, dt*9);
    n.person.position.y = K.animatePerson(n.person, n.phase, moving) || 0;
    if(n.chev){
      const off = ((now/1000)*1.25) % n.spacing, dm = S._dummy || (S._dummy = new T.Object3D());
      for(let i=0;i<n.count;i++){
        const s = off + i*n.spacing, q = n.poly.at(s), ahead = s > n.s - .2;
        dm.position.set(q.x, .085, q.z); dm.rotation.set(0, Math.atan2(q.dx, q.dz), 0); const sc = ahead ? 1 : .001; dm.scale.set(sc, sc, sc); dm.updateMatrix(); n.chev.setMatrixAt(i, dm.matrix);
      }
      n.chev.instanceMatrix.needsUpdate = true;
    }
    const t = now/1000; n.pin.position.y = Math.sin(t*2.6)*.12;
    const k = (t*.8) % 1; n.ring.scale.setScalar(1 + k*2.2); n.ring.material.opacity = .8*(1-k);
    if(n.glow) n.glow.material.opacity = .18 + .2*(.5 + .5*Math.sin(t*4));
    if(S.view === 'follow' && S.camera){
      const back = 6.2, up = 5.2, cx = p.x - p.dx*back, cz = p.z - p.dz*back, a = Math.min(1, dt*3.2);
      S.camera.position.x += (cx - S.camera.position.x)*a; S.camera.position.y += (up - S.camera.position.y)*a; S.camera.position.z += (cz - S.camera.position.z)*a;
      S.controls.target.set(S.controls.target.x + (p.x + p.dx*2.2 - S.controls.target.x)*a, 1, S.controls.target.z + (p.z + p.dz*2.2 - S.controls.target.z)*a);
    }
    if(!n.lastHud || now - n.lastHud > 120){ n.lastHud = now; updateHud(n, n.s, arrivedPhase); }
  }

  /* One animation driver for the walker/arrows, independent of which code created the renderer. */
  (function loop(){ let last = performance.now(); const f = () => { requestAnimationFrame(f); const now = performance.now(), dt = Math.min(.05, (now - last)/1000); last = now; if(S.nav && S.canvas && S.canvas.isConnected) { try{ tick(dt, now); }catch(e){ console.warn('[DevX nav3d]', e); } } }; requestAnimationFrame(f); })();

  /* Same as before, plus resize handling. */
  window.mountStoreNav3D = async function(idx, canvasId='storeNav3dCanvas', loadingId='storeNav3dLoading'){
    const ok = await storeNav3dEnsure(); if(!ok) return;
    const canvas = document.getElementById(canvasId); if(!canvas) return;
    const T = S.THREE;
    if(S.renderer && S.canvas !== canvas){ cancelAnimationFrame(S.frame); try{ S.controls?.dispose?.(); S.renderer.dispose(); }catch(e){} S.renderer = null; S.scene = null; S.camera = null; S.controls = null; S.objects = []; S.routeDots = []; S.walkers = []; S.nav = null; }
    S.canvas = canvas; S.root = canvas;
    const host = canvas.parentElement, w = Math.max(300, host.clientWidth), h = Math.max(260, host.clientHeight);
    if(!S.renderer){
      S.scene = new T.Scene(); S.camera = new T.PerspectiveCamera(45, w/h, .1, 1000);
      S.renderer = new T.WebGLRenderer({ canvas, antialias:true, alpha:false });
      S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75)); S.renderer.shadowMap.enabled = true; S.renderer.shadowMap.type = T.PCFSoftShadowMap; S.renderer.outputColorSpace = T.SRGBColorSpace;
      S.renderer.toneMapping = T.ACESFilmicToneMapping; S.renderer.toneMappingExposure = 1.05;
      S.controls = new S.OrbitControls(S.camera, canvas); S.controls.enableDamping = true; S.controls.dampingFactor = .07; S.controls.maxPolarAngle = Math.PI*.48; S.controls.minDistance = 4; S.controls.maxDistance = 180;
      canvas.addEventListener('pointerdown', () => { if(S.view === 'follow'){ S.view = 'free'; viewBtns('free'); } }, { passive:true });
      const animate = () => { S.frame = requestAnimationFrame(animate); if(S.controls) S.controls.update(); if(S.renderer && S.scene && S.camera) S.renderer.render(S.scene, S.camera); };
      animate();
      if(!S.resizeBound){ S.resizeBound = true; window.addEventListener('resize', () => resizeStoreNav3D()); }
    }
    resizeStoreNav3D(); storeNav3dBuild(idx);
    const l = document.getElementById(loadingId); if(l) l.style.display = 'none';
  };

  function viewBtns(active){
    ['storeNav3dFollowBtn','storeNav3dIsoBtn','storeNav3dTopBtn','homeStoreNav3dIsoBtn','homeStoreNav3dTopBtn'].forEach(id => {
      const b = document.getElementById(id); if(!b) return;
      const v = /Follow/.test(id) ? 'follow' : (/Iso/.test(id) ? 'iso' : 'top'); b.classList.toggle('active', v === active);
    });
  }
  function storeNav3dApplyView(){
    if(!S.camera || !S.controls) return; const { W, D } = storeNav3dDims();
    if(S.view === 'follow'){ const n = S.nav, p = n ? n.poly.at(n.s) : { x:W/2, z:D*.8, dx:0, dz:-1 }; S.camera.position.set(p.x - p.dx*6.2, 5.2, p.z - p.dz*6.2); S.controls.target.set(p.x + p.dx*2.2, 1, p.z + p.dz*2.2); }
    else if(S.view === 'top'){ S.camera.position.set(W/2, Math.max(W, D)*1.25, D/2 + .01); S.controls.target.set(W/2, 0, D/2); }
    else { S.camera.position.set(W*1.02, Math.max(14, D*.85), D*1.1); S.controls.target.set(W/2, 0, D/2); }
    S.controls.update(); viewBtns(S.view);
  }
  window.storeNav3dIso = function(){ S.view = 'iso'; storeNav3dApplyView(); };
  window.storeNav3dTop = function(){ S.view = 'top'; storeNav3dApplyView(); };
  window.storeNav3dFollow = function(){ S.view = 'follow'; storeNav3dApplyView(); };
  window.homeStoreNav3dIso = function(){ storeNav3dIso(); };
  window.homeStoreNav3dTop = function(){ storeNav3dTop(); };

  /* Home page keeps its 3D overview; the guide starts in "Follow" (driver view). */
  const _home = window.renderHomeStoreNav3D;
  window.renderHomeStoreNav3D = function(){ if(S.view === 'follow') S.view = 'iso'; return _home.apply(this, arguments); };

  window.renderStoreNavGuide = function(){
    const stops = STORE_NAV_STOPS, idx = STORE_NAV_GUIDE_INDEX, cur = stops[idx];
    const title = document.getElementById('storeNavGuideTitle'), st = document.getElementById('storeNavGuideStepTitle'), tx = document.getElementById('storeNavGuideStepText'), bar = document.getElementById('storeNavGuideProgress'), map = document.getElementById('storeNavGuideMap'), next = document.getElementById('storeNavGuideNext');
    if(!cur || !title || !st || !tx || !bar || !map || !next) return;
    title.textContent = `Stop ${idx+1} of ${stops.length}`;
    st.textContent = cur.isCheckout ? 'Checkout Counter' : (cur.loc ? `Aisle ${cur.loc.aisle} · Rack ${cur.loc.rack} · Shelf ${cur.loc.shelf}` : 'Location needs store update');
    tx.textContent = cur.isCheckout ? 'You’ve reached the final stop — complete your shopping at checkout.' : cur.loc ? `Pick ${cur.items.map(x => `${x.name}${x.qty > 1 ? ' ×' + x.qty : ''}`).join(', ')}. ${idx < stops.length-1 ? 'Then continue to the next highlighted stop.' : 'You’ve reached the final stop — head to checkout.'}` : `Pick ${cur.items.map(x => x.name).join(', ')} and ask the store team for the exact location.`;
    bar.style.width = `${Math.round((idx+1)/stops.length*100)}%`;
    if(S.guideStarted !== true){ S.view = 'follow'; S.guideStarted = true; }
    map.innerHTML = `<div class="store-nav-3d-card" id="storeNav3dCard">
      <div class="store-nav-3d-head"><div class="store-nav-3d-head-copy"><div class="store-nav-3d-kicker">LIVE 3D STORE PATH</div><div class="store-nav-3d-title">Follow the arrows</div><div class="store-nav-3d-sub">Same published Admin map · turn-by-turn to this stop</div></div><div class="store-nav-3d-actions"><button type="button" id="storeNav3dFollowBtn" onclick="storeNav3dFollow()">Follow</button><button type="button" id="storeNav3dIsoBtn" onclick="storeNav3dIso()">3D</button><button type="button" id="storeNav3dTopBtn" onclick="storeNav3dTop()">Top</button></div></div>
      <div class="store-nav-3d-wrap"><canvas id="storeNav3dCanvas" class="store-nav-3d-canvas" aria-label="3D store navigation path"></canvas><div id="storeNav3dLoading" class="store-nav-3d-loading">Loading your 3D store path…<div><small>Using the same published Admin store layout.</small></div></div></div><div class="store-nav-3d-note">Drag to look around · Follow keeps the camera behind you</div>
    </div>`;
    viewBtns(S.view);
    next.textContent = idx < stops.length-1 ? 'Next stop →' : 'Finish route ✓';
    setTimeout(() => mountStoreNav3D(idx), 20);
  };
  const _close = window.closeStoreNavGuide;
  window.closeStoreNavGuide = function(){ S.guideStarted = false; try{ speechSynthesis.cancel(); }catch(e){} return _close.apply(this, arguments); };
})();
