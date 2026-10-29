// App update prompt. Moved from App.jsx; the only change is that appState and updateAvailable are props.
function UpdateBanner({appState, updateAvailable}) {
  return (
          <button onClick={()=>{
            saveApp(appState);
            // Ask the worker to check for a new sw.js, then reload. Deliberately NOT
            // a cache purge: the worker is versioned, so the new one installs under a
            // new cache name and retires the old one only after its required shell is
            // cached. Purging first left a client that lost connectivity mid-update
            // with no cache at all — and the old code purged the whole ORIGIN,
            // unregistering every other app hosted here.
            // Reload only once the new worker is ACTIVATED. update() resolves at
            // "installing", before the new cache is populated, so reloading on it can
            // land a cache-busted URL on the OLD worker with nothing cached under that
            // query. On failure we stay on this page — it still works — rather than
            // navigating somewhere that may not resolve offline.
            const go = () => { window.location.href = window.location.pathname + "?update=" + Date.now(); };
            if('serviceWorker' in navigator && navigator.serviceWorker.getRegistration) {
              navigator.serviceWorker.getRegistration().then(reg => {
                if(!reg) { go(); return; }
                return reg.update().then(() => {
                  const sw = reg.installing || reg.waiting;
                  if(!sw) { go(); return; }
                  if(sw.state === "activated") { go(); return; }
                  sw.addEventListener("statechange", () => {
                    if(sw.state === "activated") go();
                  });
                });
              }).catch(() => {});
            } else {
              go();
            }
          }} style={{width:"100%",padding:"12px 16px",borderRadius:12,border:"2px solid #7c3aed",background:"linear-gradient(135deg,#1e1040,#2d1060)",color:"white",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
            <div style={{flex:1,textAlign:"left"}}>
              <div style={{fontSize:13,fontWeight:800}}>🎉 Update Available — v{updateAvailable.version}</div>
              {updateAvailable.notes && <div style={{fontSize:11,color:"#e9d5ff",marginTop:4,lineHeight:1.4}}>{updateAvailable.notes}</div>}
              <div style={{fontSize:10,color:"#c4b5fd",marginTop:3}}>Tap to update. No data will be lost.</div>
            </div>
            <span style={{fontSize:22}}>↻</span>
          </button>
  );
}
