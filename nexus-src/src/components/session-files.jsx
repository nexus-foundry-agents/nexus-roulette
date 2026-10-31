// Session backup, export and import helpers. Moved from App.jsx; the only changes are parameters.

  function autoExport(allSessions) {
    // Keep the automatic backup on the user's filesystem. Cancelling the download never changes
    // the saved session itself.
    try {
      const data = {
        exportedAt: new Date().toISOString(),
        autoExport: true,
        sessions: allSessions.map(s=>({...s, metrics:computeMetrics(s)})),
        aggregate: {
          totalSessions: allSessions.length,
          totalSpins: allSessions.reduce((a,s)=>a+s.spins.length,0),
          netPnL: allSessions.reduce((a,s)=>a+computeMetrics(s).netPnL,0)
        }
      };
      const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "nexus-roulette-autosave-"+new Date().toISOString().slice(0,10)+".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) { /* silently fail if download blocked */ }
  }

function exportSessionsJSON(saved) {
    const data={exportedAt:new Date().toISOString(),sessions:saved.map(s=>({...s,metrics:computeMetrics(s)})),aggregate:{totalSessions:saved.length,totalSpins:saved.reduce((a,s)=>a+s.spins.length,0),netPnL:saved.reduce((a,s)=>a+computeMetrics(s).netPnL,0)}};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download="nexus-roulette-export-"+Date.now()+".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// The import parks every active track of the session it loads, and each parked track gets its park point at the session's
// spin count (migrateParkPoints, session.js). A park point the track already has is kept.
function parkImportedSession(loaded) {
  (loaded.tracks||[]).forEach(function(tr){ if(tr.state==="active") tr.state="parked"; });
  return migrateParkPoints(loaded);
}

// confirm is App's in-app dialog (useConfirm, ConfirmDialog.jsx); the import reports through it as a notice, never alert().
function pickSessionsFile(updApp, setTab, confirm) {
    const notify = (title, body) => confirm({title, body, confirmLabel:"OK", notice:true});
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result);
          // Handle session exports and older whole-app snapshot files.
          const sessions = data.sessions || data.savedSessions || (data.appState && data.appState.savedSessions) || [];
          if (!sessions.length) { notify("No sessions found in file."); return; }
          let added = 0, skipped = 0, lastAdded = null;
          updApp(s => {
            sessions.forEach(sess => {
              if (!s.savedSessions.find(x => x.id === sess.id)) {
                s.savedSessions.push(sess);
                added++;
                lastAdded = sess;
              } else {
                skipped++;
              }
            });
            // Load the most recent imported session as current (paused)
            if(lastAdded) {
              var loaded = JSON.parse(JSON.stringify(lastAdded));
              // Always end the session - don't auto-start after import
              if(loaded.sessionStartedAt) {
                loaded.sessionEndedAt = loaded.modified || Date.now();
              }
              // Park all tracks, each with its park point at this session's spin count
              parkImportedSession(loaded);
              s.currentSession = loaded;
            }
          });
          setTab(0);
          notify("Import complete!", `${added} session${added!==1?"s":""} added${skipped ? ", " + skipped + " already existed (skipped)" : ""}.\n\nLoaded "${lastAdded?lastAdded.name:""}".`);
        } catch(err) {
          notify("Failed to parse file", err.message);
        }
      };
      reader.readAsText(file);
    };
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
}
