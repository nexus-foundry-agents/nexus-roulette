// Strategy bet chips shown on the roulette board. Moved from App.jsx; the only change is that the tracks
// are a parameter instead of an App closure.
function computeStratChips(nonClosedTracks) {
    const chips = {};
    function addChip(posKey, amount, color) {
      if(!chips[posKey]) chips[posKey] = [];
      // Merge with existing chip of same color
      var existing = chips[posKey].find(function(c){return c.color===color;});
      if(existing) existing.amount += amount;
      else chips[posKey].push({amount:amount, color:color});
    }
    nonClosedTracks.filter(function(t){return t.state==="active";}).forEach(function(t){
      var tbl = computeTableForTrack(t);
      var row = tbl[Math.min(t.level, tbl.length-1)];
      if(!row) return;
      var betAmt = row.c * (t.config.unit||1);
      if(t.type==="fibonacci") {
        var dts=t.config.dozenTargets||[], cts=t.config.colTargets||[], evts=t.config.evenTargets||[];
        dts.forEach(function(d){ addChip("dozen:"+d, betAmt, t.color); });
        cts.forEach(function(c){ addChip("column:"+c, betAmt, t.color); });
        evts.forEach(function(key){ addChip(key, betAmt, t.color); });
      }
      if(t.type==="solution") {
        (t.config.activeBets||[]).forEach(function(b){
          var bRow = tbl[Math.min(b.level, tbl.length-1)];
          if(bRow) addChip("s:"+b.number, bRow.c*(t.config.unit||1), t.color);
        });
      }
      if(t.type==="custom") {
        (t.config.positions||[]).forEach(function(p){
          var chipAmt = p.baseAmount*row.c*(t.config.unit||1);
          if(isInsideBet(p.type)) {
            // For inside bets, place chip on first number of the group
            var nums = betCoveredNumbers(p.type, p.target);
            if(nums.length>0) addChip("s:"+nums[0], chipAmt, t.color);
          } else {
            var posKey = p.type+(p.target!==undefined?":"+p.target:"");
            addChip(posKey, chipAmt, t.color);
          }
        });
      }
    });
    return chips;
  }
