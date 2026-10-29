// Applies the first-run setup choices to app state. Moved from App.jsx; the only change is that updApp is a parameter.
function completeOnboarding(updApp, {roulette, bankroll, defaultBuyIn, currency: curr, tableMinBet, tableMaxBet, tableMaxTotal}) {
          updApp(s => {
            const prevBankroll = s.settings._restartBankroll;
            s.settings.onboarded = true;
            s.settings.currency = curr;
            s.settings.defaultBuyIn = defaultBuyIn;
            if(tableMinBet) s.settings.tableMinBet = tableMinBet;
            if(tableMaxBet) s.settings.tableMaxBet = tableMaxBet;
            if(tableMaxTotal) s.settings.tableMaxTotal = tableMaxTotal;
            delete s.settings._restartBankroll;
            if(prevBankroll !== undefined) {
              // Restart -- adjust existing session's bankroll
              const delta = bankroll - prevBankroll;
              s.currentSession.roulette = roulette;
              s.currentSession.droughts = initDroughts(roulette);
              if(delta > 0) {
                // Added money → Buy In
                s.currentSession.bankrollCurrent = Math.round((s.currentSession.bankrollCurrent + delta)*100)/100;
                s.currentSession.totalBuyIn = (s.currentSession.totalBuyIn||0) + delta;
                if(!s.currentSession.buyIns) s.currentSession.buyIns = [];
                s.currentSession.buyIns.push({amount:delta,at:Date.now(),spin:s.currentSession.spins.length,note:"onboarding restart"});
              } else if(delta < 0) {
                // Removed money → Cash Out
                const cashAmt = Math.abs(delta);
                s.currentSession.bankrollCurrent = Math.round((s.currentSession.bankrollCurrent - cashAmt)*100)/100;
                s.currentSession.totalCashOut = (s.currentSession.totalCashOut||0) + cashAmt;
                if(!s.currentSession.cashOuts) s.currentSession.cashOuts = [];
                s.currentSession.cashOuts.push({amount:cashAmt,at:Date.now(),spin:s.currentSession.spins.length,note:"onboarding restart"});
              }
            } else {
              // Fresh start
              s.currentSession = newSession(roulette, bankroll);
              s.gameSession = newSession(roulette, bankroll);
            }
          });
}
