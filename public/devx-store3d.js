/* DevX NeXus — realistic 3D store kit (additive).
   Shared by the Admin Store Studio and the customer 3D navigation.
   Everything here is pure THREE geometry: no external assets, no network.
   Callers pass their own THREE module instance (T). */
(function(){
  const K = {};
  const CACHE = new WeakMap();
  function cache(T){ let c = CACHE.get(T); if(!c){ c = {}; CACHE.set(T, c); } return c; }

  function hash(s){ let h = 2166136261; s = String(s||''); for(let i=0;i<s.length;i++){ h = Math.imul(h ^ s.charCodeAt(i), 16777619); } return h>>>0; }
  function rng(seed){ let t = seed>>>0; return function(){ t += 0x6D2B79F5; let r = Math.imul(t ^ t>>>15, 1|t); r ^= r + Math.imul(r ^ r>>>7, 61|r); return ((r ^ r>>>14)>>>0)/4294967296; }; }
  K.hash = hash; K.rng = rng;

  /* Packaging colours tuned to read like a real grocery shelf. */
  const PACK = ['#1f5fbf','#2a7de1','#d63a2f','#f2b705','#f5f5f0','#2e9e5b','#7a4a2a','#e8702a','#6b3fa0','#0f9aa8','#c9a36b','#e94f7a','#284b3a','#ffd166','#e6e9ee','#8fb339'];

  function mat(T, key, make){ const c = cache(T); return c[key] || (c[key] = make()); }
  K.std = (T, color, rough=.7, metal=.05) => mat(T, 'std'+color+rough+metal, () => new T.MeshStandardMaterial({ color:new T.Color(color), roughness:rough, metalness:metal }));

  /* ── Procedural wood-plank floor, like the reference store ── */
  K.woodTexture = function(T){
    return mat(T, 'woodTex', () => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 512; const x = c.getContext('2d');
      const r = rng(7); const rows = 8, h = 512/rows;
      for(let i=0;i<rows;i++){
        let px = -r()*200;
        while(px < 512){
          const len = 160 + r()*220, base = 150 + r()*40;
          x.fillStyle = `rgb(${base+40|0},${base-10|0},${base-70|0})`; x.fillRect(px, i*h, len, h);
          for(let g=0; g<9; g++){ x.strokeStyle = `rgba(90,50,20,${.05+r()*.09})`; x.lineWidth = 1+r()*1.5; x.beginPath(); const gy = i*h + r()*h; x.moveTo(px, gy); x.bezierCurveTo(px+len*.3, gy+(r()-.5)*8, px+len*.6, gy+(r()-.5)*8, px+len, gy+(r()-.5)*6); x.stroke(); }
          x.fillStyle = 'rgba(60,32,12,.55)'; x.fillRect(px, i*h, 2, h);
          px += len;
        }
        x.fillStyle = 'rgba(60,32,12,.55)'; x.fillRect(0, i*h, 512, 2);
      }
      const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t;
    });
  };
  K.floorMaterial = function(T, W, D){
    const tex = K.woodTexture(T).clone(); tex.needsUpdate = true; tex.repeat.set(Math.max(1, W/6), Math.max(1, D/6));
    return new T.MeshStandardMaterial({ map:tex, color:0xffffff, roughness:.62, metalness:.02 });
  };

  /* Store shell: wood floor, painted back walls (tall), low cut-away front walls
     so the isometric camera can look in — a "dollhouse" view. */
  K.buildShell = function(T, W, D, opts={}){
    const g = new T.Group(); g.name = 'devx-shell';
    const floor = new T.Mesh(new T.BoxGeometry(W, .18, D), K.floorMaterial(T, W, D));
    floor.position.set(W/2, -.09, D/2); floor.receiveShadow = true; g.add(floor);
    const wallH = opts.wallH || 3.0, low = opts.lowH || .45, th = .22;
    const paint = K.std(T, opts.wallColor || '#1e9ccc', .85, 0), trim = K.std(T, '#f4f6f7', .5, .02);
    const wall = (x, z, sx, sz, h) => {
      const m = new T.Mesh(new T.BoxGeometry(sx, h, sz), paint); m.position.set(x, h/2, z); m.castShadow = h > 1; m.receiveShadow = true; g.add(m);
      const b = new T.Mesh(new T.BoxGeometry(sx + (sx>sz?0:.04), .16, sz + (sz>sx?0:.04)), trim); b.position.set(x, .08, z); g.add(b);
      if(h > 1){ const cap = new T.Mesh(new T.BoxGeometry(sx+.02, .1, sz+.02), trim); cap.position.set(x, h-.05, z); g.add(cap); }
    };
    wall(W/2, -th/2, W+th*2, th, wallH);        // back wall
    wall(-th/2, D/2, th, D, wallH);             // left wall
    wall(W/2, D+th/2, W+th*2, th, low);         // front (cut-away)
    wall(W+th/2, D/2, th, D, low);              // right (cut-away)
    /* Ceiling light strips floating above the floor add depth without hiding anything. */
    return g;
  };

  K.lights = function(T, W, D){
    const g = new T.Group();
    const hemi = new T.HemisphereLight(0xffffff, 0x8a7560, 1.25); g.add(hemi);
    const sun = new T.DirectionalLight(0xffffff, 1.9); sun.position.set(W*.3, Math.max(22, D*1.1), D*.2); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); const s = Math.max(W, D)*.75; Object.assign(sun.shadow.camera, { left:-s, right:s, top:s, bottom:-s, near:1, far:Math.max(80, W+D)*2 });
    sun.target.position.set(W/2, 0, D/2); g.add(sun); g.add(sun.target);
    const fill = new T.DirectionalLight(0xdfefff, .55); fill.position.set(W, 12, D); g.add(fill);
    return g;
  };

  function signTexture(T, text, bg, fg){
    const c = document.createElement('canvas'); c.width = 256; c.height = 104; const x = c.getContext('2d');
    x.fillStyle = bg; x.beginPath(); x.roundRect(4, 4, 248, 96, 48); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 5; x.stroke();
    x.fillStyle = fg; x.font = '900 54px Montserrat, Arial Black, Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 128, 56);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }
  function burstTexture(T){
    const c = document.createElement('canvas'); c.width = 128; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = '#e02424'; x.beginPath(); for(let i=0;i<24;i++){ const a = i/24*Math.PI*2, r = i%2 ? 50 : 62; x.lineTo(64+Math.cos(a)*r, 64+Math.sin(a)*r); } x.closePath(); x.fill();
    x.fillStyle = '#fff'; x.font = '900 30px Montserrat, Arial Black, Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('SALE!', 64, 66);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }

  /* ── Gondola shelving unit ──
     Built centred on the origin, occupying [-w/2..w/2] × [-h/2..h/2] × [-d/2..d/2],
     so it drops straight into the existing element groups (which are positioned at
     the body centre). Double-sided when deep enough, like a real aisle gondola. */
  K.buildGondola = function(T, o){
    const w = Math.max(.5, o.w), h = Math.max(.6, o.h), d = Math.max(.4, o.d);
    const seed = hash(o.seed || (w+'x'+d)), R = rng(seed);
    const alongX = w >= d, L = alongX ? w : d, Dp = alongX ? d : w;
    const root = new T.Group(); root.name = 'devx-gondola'; root.userData.gondola = true;
    const inner = new T.Group(); if(!alongX) inner.rotation.y = Math.PI/2; root.add(inner);
    const yb = -h/2, double = Dp >= .9;
    const metal = K.std(T, '#dfe3e7', .42, .35), dark = K.std(T, '#3a4047', .6, .25), shelfM = K.std(T, '#f1f3f5', .38, .3);
    const accent = K.std(T, /^#[0-9a-f]{6}$/i.test(o.accent||'') ? o.accent : '#27954e', .55, .05);
    const add = (geo, m, x, y, z, shadow=true) => { const q = new T.Mesh(geo, m); q.position.set(x, y, z); q.castShadow = shadow; q.receiveShadow = true; inner.add(q); return q; };

    add(new T.BoxGeometry(L, .14, Dp), dark, 0, yb+.07, 0);
    const panelZ = double ? 0 : -Dp/2 + .03;
    add(new T.BoxGeometry(L, h-.14, .05), metal, 0, yb+.14+(h-.14)/2, panelZ);
    const posts = Math.max(2, Math.round(L/1.25)+1);
    for(let i=0;i<posts;i++){ const px = -L/2 + .03 + i*(L-.06)/(posts-1); add(new T.BoxGeometry(.06, h, double?.1:.08), metal, px, 0, panelZ, false); }
    add(new T.BoxGeometry(L+.04, .09, double ? .22 : .12), accent, 0, h/2 - .045, panelZ);

    const levels = h > 1.6 ? 5 : (h > 1 ? 3 : 2);
    const sd = double ? (Dp/2 - .06)*.96 : Dp - .1;
    const sides = double ? [1, -1] : [1];
    const levelY = []; for(let i=0;i<levels;i++) levelY.push(yb + .16 + i*((h - .42)/(levels-1 || 1)));
    const gap = levels > 1 ? (levelY[1]-levelY[0]) : h*.6;

    const boxes = [], cans = [], tags = [];
    sides.forEach(s => {
      const zc = double ? s*(.03 + sd/2) : panelZ + .03 + sd/2;
      levelY.forEach((y, li) => {
        add(new T.BoxGeometry(L-.04, .035, sd), shelfM, 0, y, zc, false);
        add(new T.BoxGeometry(L-.04, .06, .014), K.std(T, '#fafafa', .5, 0), 0, y+.005, zc + s*sd/2, false);
        let px = -L/2 + .06;
        const maxH = Math.min(gap - .1, .5);
        while(px < L/2 - .12){
          const run = 2 + (R()*4|0), color = PACK[(R()*PACK.length)|0], kind = R() < .3 ? 'can' : 'box';
          const iw = .12 + R()*.16, ih = Math.max(.1, maxH*(.45 + R()*.5)), idp = sd*(.55 + R()*.35);
          if(R() < .12){ px += iw*run*.8; continue; }            // a partially empty facing, like a real shelf
          for(let k=0; k<run && px + iw < L/2 - .05; k++){
            const item = { x:px + iw/2, y:y + .02 + ih/2, z:zc + s*(sd/2 - idp/2 - .015), w:iw*.92, h:ih, d:idp, color };
            (kind === 'can' ? cans : boxes).push(item); px += iw + .012;
          }
          if(R() < .45) tags.push({ x:px - iw, y:y + .005, z:zc + s*(sd/2 + .01) });
          px += .03;
        }
      });
    });
    const dummy = new T.Object3D(), col = new T.Color();
    const inst = (geo, list, m) => {
      if(!list.length) return;
      const im = new T.InstancedMesh(geo, m, list.length); im.castShadow = false; im.receiveShadow = true;
      list.forEach((it, i) => { dummy.position.set(it.x, it.y, it.z); dummy.rotation.set(0,0,0); dummy.scale.set(it.w, it.h, it.d); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, col.set(it.color)); });
      im.instanceMatrix.needsUpdate = true; if(im.instanceColor) im.instanceColor.needsUpdate = true; inner.add(im);
    };
    inst(mat(T, 'boxGeo', () => new T.BoxGeometry(1,1,1)), boxes, mat(T, 'prodBox', () => new T.MeshStandardMaterial({ roughness:.55, metalness:.02 })));
    inst(mat(T, 'canGeo', () => new T.CylinderGeometry(.5,.5,1,10)), cans, mat(T, 'prodCan', () => new T.MeshStandardMaterial({ roughness:.35, metalness:.25 })));
    if(tags.length){
      const tg = new T.InstancedMesh(mat(T, 'tagGeo', () => new T.BoxGeometry(.13, .07, .012)), K.std(T, '#ffd21f', .5, 0), tags.length);
      tags.forEach((t, i) => { dummy.position.set(t.x, t.y, t.z); dummy.scale.set(1,1,1); dummy.updateMatrix(); tg.setMatrixAt(i, dummy.matrix); });
      inner.add(tg);
    }
    if(o.sale){
      const sign = new T.Mesh(new T.PlaneGeometry(1.25, .5), new T.MeshBasicMaterial({ map:signTexture(T, 'SALE !', '#e3262b', '#fff'), transparent:true, side:T.DoubleSide }));
      sign.position.set(L*.22, h/2 + .42, panelZ); inner.add(sign);
      const post = add(new T.BoxGeometry(.03, .2, .03), dark, L*.22, h/2 + .08, panelZ, false);
      const burst = new T.Mesh(new T.PlaneGeometry(.42, .42), new T.MeshBasicMaterial({ map:mat(T, 'burst', () => burstTexture(T)), transparent:true, side:T.DoubleSide }));
      burst.position.set(-L*.12, yb + .45, (double ? sd + .08 : panelZ + sd + .1)); inner.add(burst);
    }
    root.userData.gondolaInfo = { alongX, L, Dp, levels:levelY.map(v => v + gap*.45), sd, double, panelZ, inner };
    return root;
  };

  /* ── Human with hip / shoulder pivots so limbs swing naturally ── */
  K.makePerson = function(T, shirtColor='#1f8f55'){
    const p = new T.Group(); p.name = 'devx-walker';
    const skin = K.std(T, '#e9ad86', .7, 0), shirt = K.std(T, shirtColor, .7, 0), pants = K.std(T, '#243447', .8, 0), shoe = K.std(T, '#15171b', .6, .05), hair = K.std(T, '#2b1d14', .9, 0);
    const mesh = (geo, m, x, y, z, parent=p) => { const q = new T.Mesh(geo, m); q.position.set(x, y, z); q.castShadow = true; parent.add(q); return q; };
    const Cap = T.CapsuleGeometry || null;
    mesh(new T.SphereGeometry(.2, 20, 16), skin, 0, 1.66, 0);
    mesh(new T.SphereGeometry(.205, 20, 16, 0, Math.PI*2, 0, Math.PI*.55), hair, 0, 1.69, .01);
    mesh(new T.CylinderGeometry(.07, .08, .12, 12), skin, 0, 1.45, 0);
    mesh(Cap ? new Cap(.19, .42, 6, 14) : new T.CylinderGeometry(.2, .18, .7, 14), shirt, 0, 1.08, 0).scale.set(1, 1, .72);
    const limb = (name, x, y, len, r, m, footM) => {
      const pivot = new T.Group(); pivot.name = name; pivot.position.set(x, y, 0); p.add(pivot);
      mesh(Cap ? new Cap(r, len - 2*r, 4, 10) : new T.CylinderGeometry(r, r, len, 10), m, 0, -len/2, 0, pivot);
      if(footM) mesh(new T.BoxGeometry(.15, .08, .28), footM, 0, -len - .01, .05, pivot);
      else mesh(new T.SphereGeometry(r*1.05, 10, 8), skin, 0, -len, 0, pivot);
      return pivot;
    };
    limb('left-leg', -.1, .74, .7, .075, pants, shoe); limb('right-leg', .1, .74, .7, .075, pants, shoe);
    limb('left-arm', -.26, 1.34, .58, .055, shirt); limb('right-arm', .26, 1.34, .58, .055, shirt);
    /* shopping basket in the right hand */
    const basket = new T.Group(); basket.position.set(.34, .72, .08);
    const bm = K.std(T, '#e03a3a', .5, .05);
    mesh(new T.BoxGeometry(.26, .16, .2), bm, 0, 0, 0, basket);
    mesh(new T.TorusGeometry(.1, .012, 6, 16, Math.PI), K.std(T, '#222', .5, .3), 0, .08, 0, basket);
    p.add(basket); p.userData.basket = basket;
    return p;
  };
  K.animatePerson = function(p, phase, moving){
    const a = moving ? Math.sin(phase)*.6 : 0;
    const set = (n, v) => { const o = p.getObjectByName(n); if(o) o.rotation.x += (v - o.rotation.x)*.35; };
    set('left-leg', a); set('right-leg', -a); set('left-arm', -a*.75); set('right-arm', a*.4);
    return moving ? Math.abs(Math.sin(phase))*.035 : 0;
  };

  /* ── Route helpers (Google-Maps-style ribbon + moving chevrons) ── */
  K.polyline = function(pts){
    const seg = []; let total = 0;
    for(let i=0;i<pts.length-1;i++){ const a = pts[i], b = pts[i+1], l = Math.hypot(b.x-a.x, b.z-a.z); if(l < 1e-4) continue; seg.push({ a, b, l, s0:total, dx:(b.x-a.x)/l, dz:(b.z-a.z)/l }); total += l; }
    return { pts, seg, total, at(s){ if(!seg.length){ const p = pts[0] || {x:0,z:0}; return { x:p.x, z:p.z, dx:0, dz:1 }; } s = Math.max(0, Math.min(total, s)); let g = seg[seg.length-1]; for(const q of seg){ if(s <= q.s0 + q.l){ g = q; break; } } const t = s - g.s0; return { x:g.a.x + g.dx*t, z:g.a.z + g.dz*t, dx:g.dx, dz:g.dz }; } };
  };
  K.ribbon = function(T, poly, width, color, y, opacity=1){
    const g = new T.Group(), m = new T.MeshBasicMaterial({ color, transparent:opacity<1, opacity, depthWrite:opacity>=1 });
    poly.seg.forEach(s => { const q = new T.Mesh(new T.BoxGeometry(width, .02, s.l), m); q.position.set((s.a.x+s.b.x)/2, y, (s.a.z+s.b.z)/2); q.rotation.y = Math.atan2(s.dx, s.dz); g.add(q); });
    poly.pts.forEach(p => { const c = new T.Mesh(new T.CylinderGeometry(width/2, width/2, .02, 20), m); c.position.set(p.x, y, p.z); g.add(c); });
    g.renderOrder = 5; return g;
  };
  K.chevronGeometry = function(T, size){
    const s = new T.Shape(); const w = size*.5, h = size*.42, t = size*.22;
    s.moveTo(-w, -h*.55); s.lineTo(0, h*.45); s.lineTo(w, -h*.55); s.lineTo(w, -h*.55 + t); s.lineTo(0, h*.45 + t); s.lineTo(-w, -h*.55 + t); s.closePath();
    const g = new T.ShapeGeometry(s); g.rotateX(Math.PI/2); return g;
  };

  window.DevXStore3D = K;
})();
