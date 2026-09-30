/* DevX NeXus — install prompt + real Web Push (additive).
   Re-declares the existing prompt functions with the same names, so the
   original load handler keeps driving them.

   Platform notes
   · Android / desktop Chrome & Edge: native install via beforeinstallprompt, push works in the browser too.
   · iOS / iPadOS (Safari): no install API. Web Push exists only on 16.4+ and only once the
     app is opened from the Home Screen. So in Safari we show Share → Add to Home Screen steps,
     and the notification prompt appears on the first launch of the installed app.
   · macOS Safari 17+: File → Add to Dock. */
(function(){
  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isMacSafari = !isIOS && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);
  const iosVer = (() => { const m = ua.match(/OS (\d+)[_.](\d+)/); return m ? Number(m[1]) + Number(m[2])/10 : 0; })();
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const pushCapable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const LS = { get:k => { try{ return localStorage.getItem(k); }catch(e){ return null; } }, set:(k,v) => { try{ localStorage.setItem(k, v); }catch(e){} } };
  window.DEVX_PLATFORM = { isIOS, isAndroid, isMacSafari, iosVer, standalone, pushCapable };

  const shareIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  const plusIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

  function steps(){
    if(isIOS) return `<ol class="dx-steps"><li><span class="n">1</span><span>Tap ${shareIcon}<b>Share</b> in Safari’s toolbar</span></li><li><span class="n">2</span><span>Choose ${plusIcon}<b>Add to Home Screen</b></span></li><li><span class="n">3</span><span>Open DevX from your Home Screen and allow notifications</span></li></ol>`;
    if(isMacSafari) return `<ol class="dx-steps"><li><span class="n">1</span><span>In the menu bar choose <b>File → Add to Dock</b></span></li><li><span class="n">2</span><span>Open DevX from the Dock</span></li></ol>`;
    return '';
  }

  window.showDevXInstallPrompt = function(){
    const el = document.getElementById('devxInstallPrompt'); if(!el || standalone()) return;
    const card = el.querySelector('.devx-prompt-card');
    let box = card && card.querySelector('.dx-steps-wrap');
    if(card && !box){ box = document.createElement('div'); box.className = 'dx-steps-wrap'; card.querySelector('.devx-prompt-actions').before(box); }
    if(box) box.innerHTML = DEVX_INSTALL_DEFERRED ? '' : steps();
    const ic = card && card.querySelector('.devx-prompt-icon'); if(ic && !ic.dataset.dx){ ic.dataset.dx = '1'; ic.innerHTML = '<img src="/pwa-icon-192.png" alt="" style="width:100%;height:100%;border-radius:inherit;object-fit:cover">'; ic.style.padding = '0'; ic.style.overflow = 'hidden'; }
    const btn = document.getElementById('devxInstallBtn'), hint = document.getElementById('devxInstallHint');
    if(btn){ btn.textContent = DEVX_INSTALL_DEFERRED ? 'Install app' : (isIOS ? 'Show me how' : 'Install web app'); btn.style.display = (isIOS || isMacSafari) ? 'none' : ''; }
    if(hint){
      hint.textContent = isIOS
        ? (iosVer && iosVer < 16.4 ? 'Update to iOS 16.4 or later to receive notifications from the installed app.' : 'Notifications on iPhone and iPad work once DevX is opened from the Home Screen.')
        : DEVX_INSTALL_DEFERRED ? 'Installs in one tap — no app store, no download size worries.' : 'Look for the install icon in your browser’s address bar or menu.';
    }
    el.classList.add('on', 'dx-center');
  };

  /* After install (or on iOS standalone launch) ask for notifications. */
  window.maybeShowDevXNotificationPrompt = function(){
    if(!('Notification' in window)) return;
    /* iOS/iPadOS: Web Push only exists inside the Home Screen app on 16.4+, never in Safari itself. */
    if(isIOS && (!standalone() || !pushCapable())) return;
    if(Notification.permission === 'granted'){ devxEnsurePush(false); return; }
    if(Notification.permission !== 'default') return;
    const dismissed = LS.get('devx-notification-prompt-dismissed') === '1';
    const firstInstalledLaunch = standalone() && LS.get('devx-standalone-asked') !== '1';
    if(dismissed && !firstInstalledLaunch) return;
    setTimeout(() => {
      const install = document.getElementById('devxInstallPrompt');
      if(install && install.classList.contains('on')) return;
      if(standalone()) LS.set('devx-standalone-asked', '1');
      const p = document.getElementById('devxNotificationPrompt'); if(!p) return;
      const sub = p.querySelector('.devx-prompt-sub');
      if(sub && standalone()) sub.textContent = 'DevX is installed. Allow notifications to get order updates, offers and store alerts straight in your phone’s notification centre — even when the app is closed.';
      p.classList.add('on', 'dx-center');
    }, standalone() ? 900 : 3000);
  };

  /* Must stay a direct result of the button tap — iOS rejects permission requests otherwise. */
  window.allowDevXNotifications = async function(){
    if(!('Notification' in window)){ declineDevXNotifications(); return; }
    let permission = 'default';
    try{ permission = await Notification.requestPermission(); }catch(e){}
    document.getElementById('devxNotificationPrompt')?.classList.remove('on');
    if(permission === 'granted'){
      LS.set('devx-notification-enabled', '1');
      const ok = await devxEnsurePush(true);
      showToast(ok ? 'Notifications on — check your notification centre ✓' : 'Notifications enabled ✓', 'green');
    } else LS.set('devx-notification-prompt-dismissed', '1');
  };

  window.closeDevXInstallPrompt = function(){
    document.getElementById('devxInstallPrompt')?.classList.remove('on');
    LS.set('devx-install-prompt-dismissed', String(Date.now()));
    if(!isIOS || standalone()) setTimeout(() => { if('Notification' in window && Notification.permission === 'default' && LS.get('devx-notification-prompt-dismissed') !== '1') document.getElementById('devxNotificationPrompt')?.classList.add('on', 'dx-center'); }, 450);
  };

  function b64ToBytes(b){ const pad = '='.repeat((4 - b.length % 4) % 4), s = atob((b + pad).replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(s.length); for(let i=0;i<s.length;i++) out[i] = s.charCodeAt(i); return out; }
  function headers(){ const h = { 'Content-Type':'application/json' }; try{ if(typeof CTOKEN !== 'undefined' && CTOKEN) h['x-customer-token'] = CTOKEN; }catch(e){} return h; }

  /* Subscribe (or refresh) this device and link it to the signed-in shopper. */
  async function devxEnsurePush(welcome){
    try{
      if(!pushCapable() || Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.register('/sw.js', { scope:'/' }).then(() => navigator.serviceWorker.ready);
      const r = await fetch('/api/push/key', { cache:'no-store' }); const { publicKey } = await r.json(); if(!publicKey) return false;
      let sub = await reg.pushManager.getSubscription();
      const want = b64ToBytes(publicKey);
      if(sub && sub.options && sub.options.applicationServerKey){ const have = new Uint8Array(sub.options.applicationServerKey); if(have.length !== want.length || have.some((v,i) => v !== want[i])){ await sub.unsubscribe(); sub = null; } }
      if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:want });
      const res = await fetch('/api/push/subscribe', { method:'POST', headers:headers(), body:JSON.stringify({ subscription:sub.toJSON(), welcome:!!welcome, platform:isIOS ? 'ios' : isAndroid ? 'android' : 'desktop', standalone:standalone() }) });
      return res.ok;
    }catch(e){ console.warn('[DevX push] subscribe failed', e); return false; }
  }
  window.devxEnsurePush = devxEnsurePush;
  window.devxTestPush = async function(){ await devxEnsurePush(false); const r = await fetch('/api/push/test-me', { method:'POST', headers:headers() }); return r.json(); };

  /* In-app fallback: use the service worker so it also works on Android/iOS (new Notification() throws there).
     Same tag as the server push, so the OS shows it once. */
  window.maybeToastNewNotif = function(){
    const n = visibleNotifs();
    if(n.length && !READS.has(n[0].id) && n[0].id !== nxLastNotifId){
      nxLastNotifId = n[0].id; showToast('🔔 ' + n[0].title, 'green'); notificationChime();
      if('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible'){
        const opts = { body:n[0].msg || 'You have a new DevX update.', icon:'/pwa-icon-192.png', badge:'/pwa-icon-192.png', tag:String(n[0].id || 'devx-update') };
        (navigator.serviceWorker ? navigator.serviceWorker.getRegistration() : Promise.resolve(null)).then(reg => { if(reg) reg.showNotification(n[0].title || 'DevX NeXus', opts); else try{ new Notification(n[0].title || 'DevX NeXus', opts); }catch(e){} }).catch(() => {});
      }
    }
  };

  /* Re-link the device after sign-in so personal order updates reach it. */
  let lastTok = null;
  setInterval(() => { try{ const t = typeof CTOKEN !== 'undefined' ? CTOKEN : ''; if(t !== lastTok){ lastTok = t; if('Notification' in window && Notification.permission === 'granted') devxEnsurePush(false); } }catch(e){} }, 4000);

  window.addEventListener('appinstalled', () => { LS.set('devx-install-complete', '1'); setTimeout(() => window.maybeShowDevXNotificationPrompt(), 800); });
  if(navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', ev => { if(ev.data && ev.data.type === 'devx-open' && ev.data.url && ev.data.url !== location.pathname) location.href = ev.data.url; });
})();
