#!/usr/bin/env node
// Nexus Roulette — Build Script
// Concatenates source files in dependency order, compiles JSX, bundles React, outputs index.html

const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const REACT = path.join(__dirname, '../node_modules/react/umd/react.production.min.js');
const REACTDOM = path.join(__dirname, '../node_modules/react-dom/umd/react-dom.production.min.js');
const NF_TOKENS = path.join(__dirname, '../node_modules/@nexus-foundry/nf-ui/src/tokens.css');
const NF_UI = path.join(__dirname, '../node_modules/@nexus-foundry/nf-ui/src/nf-ui.css');
const OUT = path.join(__dirname, '../index.html');

// Files concatenated in dependency order
const FILES = [
  // Pure data / constants
  'constants.js',
  'account-storage.mjs',
  // Engine — depends on constants
  'engine.js',
  // Session factories — depends on engine
  'session.js',
  // Spin application — the one settlement path for a live tap and for the replay that corrects a spin. Depends on engine + constants + session.
  'spin-apply.js',
  // Simulation engine — depends on engine + constants
  'simulation.js',
  // Base UI — depends on constants
  'roulette-bets.mjs',
  'components/ui.jsx',
  'components/RouletteIcon.jsx',
  // Grids — depends on engine + constants + ui
  'components/grids.jsx',
  'components/ResultFlash.jsx',
  // Track panels — depends on grids + ui + engine
  'components/TrackPanel.jsx',
  // Modals — depends on ui
  'components/modals.jsx',
  // Live-mode spin tools (clear numbers with inline undo) and the recent-numbers strip — depends on ui (Modal) and constants
  'components/SpinTools.jsx',
  // Board photo reader (F3.2) — the photo button's destination, the return-hash parse, the status line and the review.
  // Depends on ui (Modal), SpinTools (NumberPicker) and constants (getWheelNumbers, RED).
  'components/BoardPhoto.jsx',
  // Sim UI — depends on simulation + ui + engine
  'components/SimModePage.jsx',
  // Secondary pages split from App.jsx before the Casino bridge was added.
  'components/SecondaryPages.jsx',
  // Exact-origin Casino recording client and wager accounting.
  'casino-recording.mjs',
  // Local-first, revision-aware account synchronization through the pinned shell bridge.
  'casino-sync.mjs',
  // Helpers and page views split out of App.jsx. Each depends only on files listed above it.
  'components/strat-chips.jsx',
  'components/session-files.jsx',
  'components/onboarding-apply.jsx',
  'components/UpdateBanner.jsx',
  'components/DroughtPanel.jsx',
  'components/GamePage.jsx',
  'components/TablePage.jsx',
  // App — depends on everything. Keeps the coordinator, the hooks and the live Tracker page.
  'App.jsx',
];

console.log('Building Nexus Roulette...');

const combined = FILES.map(f => {
  const filePath = path.join(SRC, f);
  const content = fs.readFileSync(filePath, 'utf8');
  console.log(`  ${f.padEnd(35)} ${content.split('\n').length} lines`);
  return `\n// ===== ${f} =====\n` + content;
}).join('\n');

console.log(`\nTotal source: ${combined.split('\n').length} lines`);

// Compile
let compiled;
try {
  const result = babel.transformSync(combined, {
    presets: [
      ['@babel/preset-react', { runtime: 'classic' }],
      ['@babel/preset-env', { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }]
    ],
    filename: 'app.jsx'
  });
  compiled = result.code;
  console.log(`Compiled: ${Math.round(compiled.length / 1024)}KB`);
} catch (e) {
  console.error('Compile error:', e.message.slice(0, 300));
  process.exit(1);
}

const react = fs.readFileSync(REACT, 'utf8');
const reactdom = fs.readFileSync(REACTDOM, 'utf8');
const nfTokens = fs.readFileSync(NF_TOKENS, 'utf8');
const nfUi = fs.readFileSync(NF_UI, 'utf8');

const iife = `(function(){
  function require(m){
    if(m==='react')return window.React;
    if(m==='react-dom')return window.ReactDOM;
    return{};
  }
  var module={exports:{}},exports=module.exports;
  ${compiled}
  var App=module.exports['default']||module.exports;
  class EB extends React.Component{
    constructor(p){super(p);this.state={e:null};}
    static getDerivedStateFromError(e){return{e:e};}
    render(){
      if(this.state.e)return React.createElement('pre',
        {style:{color:'#f87171',padding:'20px',fontSize:'11px',whiteSpace:'pre-wrap',background:'#0f1923',minHeight:'100vh',margin:0}},
        'Error: '+this.state.e.message+'\\n\\n'+this.state.e.stack
      );
      return this.props.children;
    }
  }
  ReactDOM.createRoot(document.getElementById('root')).render(
    React.createElement(EB,null,React.createElement(App,null))
  );
})();`;

const appVersion = compiled.match(/APP_VERSION\s*=\s*"([^"]+)"/);
const versionStr = appVersion ? appVersion[1] : "0.0.0";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Nexus Roulette">
<meta name="theme-color" content="#0f1923">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<title>Nexus Roulette Tracker</title>
<style>
${nfTokens}
${nfUi}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#0f1923;min-height:100%;}
button{-webkit-tap-highlight-color:transparent;touch-action:manipulation;font-family:inherit;cursor:pointer;}
*,*::before,*::after{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;}
input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text;}
#root{min-height:100vh;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
</style>
<script>
// Pre-app update check — runs before React, works even when HTML is cached
(function(){
  var MY_V="${versionStr}";
  try{
    fetch("version.json?t="+Date.now()).then(function(r){return r.json();}).then(function(d){
      if(d.version && d.version!==MY_V && !sessionStorage.getItem("nexus_updating")){
        sessionStorage.setItem("nexus_updating","1");
        // Do NOT delete caches or unregister here. The worker is versioned: a new
        // sw.js installs under a new cache name and its activate handler retires the
        // old one only AFTER the new required shell is cached. Deleting first opened
        // a window where a client that lost connectivity had no cache at all — and
        // the old code did it origin-wide, taking every other app on the host with it.
        //
        // Reload only once the new worker is ACTIVATED. update() resolves as soon as
        // the worker reaches "installing", well before its precache finishes, so
        // reloading on that promise can land a cache-busted URL on the old worker
        // with nothing cached under that query string. On failure we stay put: the
        // page keeps working on the version it already has and retries next launch.
        var go=function(){window.location.href=window.location.pathname+"?v="+Date.now();};
        var stay=function(){try{sessionStorage.removeItem("nexus_updating");}catch(e){}};
        if('serviceWorker' in navigator&&navigator.serviceWorker.getRegistration){
          navigator.serviceWorker.getRegistration().then(function(reg){
            if(!reg){go();return;}
            return reg.update().then(function(){
              var sw=reg.installing||reg.waiting;
              if(!sw){go();return;}
              if(sw.state==="activated"){go();return;}
              sw.addEventListener("statechange",function(){
                if(sw.state==="activated")go();
                else if(sw.state==="redundant")stay();
              });
            });
          }).catch(stay);
        } else { go(); }
      } else {
        sessionStorage.removeItem("nexus_updating");
      }
    });
  }catch(e){}
})();
</script>
</head>
<body>
<div id="root"></div>
<script>${react}</script>
<script>${reactdom}</script>
<script>
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js');}
${iife}
</script>
</body>
</html>`;

// Generated artifacts are canonical LF on every host. Several source inputs predate the build and
// carry mixed endings; writing those through unchanged made a Windows build differ from CI bytes.
const canonicalHtml = html.replace(/\r\n?/g, '\n');
fs.writeFileSync(OUT, canonicalHtml, 'utf8');
console.log(`\n✓ Built: ${OUT}`);
console.log(`  Size: ${Math.round(canonicalHtml.length / 1024)}KB`);
