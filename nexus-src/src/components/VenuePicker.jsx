// -- Venue picker (F11): the one venue form, used by the Live start step, the edit sheet and the end confirm --
// Each field is a list of values used before, most recent first, plus "Add new...", which opens an inline text
// field. The list is not a native <select>: the operating system draws that list, and no CSS reaches it. The
// trigger and the listbox use the nf-ui select and menu classes, so they take the product's control surface.
// Reserved space (rule 82): the machine and table fields share one grid cell and only their visibility changes;
// the add-new input shares its cell with the trigger; the note line keeps its height.

const VENUE_FIELD_LABEL={casino:'Casino',maker:'Maker',model:'Model',version:'Version',table:'Table',dealer:'Dealer'};

// One venue field: a trigger that shows the value, a listbox that opens over the content (it never pushes a sibling),
// and an inline text field for a new value. The dismissal gesture must begin and end outside the listbox and trigger
// (rule 79); Escape closes it.
function VenueValueField({field,value,options,disabled,onPick,onAdd}) {
  const [open,setOpen]=React.useState(false);
  const [adding,setAdding]=React.useState(false);
  const [text,setText]=React.useState('');
  const triggerRef=React.useRef(null);
  const listRef=React.useRef(null);
  const inputRef=React.useRef(null);
  const label=VENUE_FIELD_LABEL[field];
  // Choice lists leave out the value already applied (rule 78). "Not set" is the one way to clear it.
  const choices=venueChoiceList(options,value);

  React.useEffect(()=>{
    if(!open)return undefined;
    let downOutside=false;
    const inside=t=>!!((listRef.current&&listRef.current.contains(t))||(triggerRef.current&&triggerRef.current.contains(t)));
    const down=e=>{downOutside=!inside(e.target);};
    const up=e=>{if(downOutside&&!inside(e.target))setOpen(false);downOutside=false;};
    const key=e=>{if(e.key==='Escape')setOpen(false);};
    document.addEventListener('pointerdown',down,true);
    document.addEventListener('pointerup',up,true);
    document.addEventListener('keydown',key);
    return ()=>{
      document.removeEventListener('pointerdown',down,true);
      document.removeEventListener('pointerup',up,true);
      document.removeEventListener('keydown',key);
    };
  },[open]);

  React.useEffect(()=>{if(adding&&inputRef.current)inputRef.current.focus();},[adding]);

  function commitText(){
    const t=text.trim();
    if(!t)return;
    onAdd(t);
    setText('');
    setAdding(false);
  }
  function cancelText(){setText('');setAdding(false);}

  const cellStyle={gridArea:'1 / 1',minWidth:0,height:40};
  return (
    <div style={{position:'relative',minWidth:0,width:'100%'}}>
      <div style={{fontSize:10,color:'#64748b',textTransform:'uppercase',letterSpacing:1,marginBottom:6}}>{label}</div>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',minHeight:40}}>
        <button
          ref={triggerRef}
          type="button"
          className="nf-select__trigger"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          aria-hidden={adding}
          onClick={()=>setOpen(o=>!o)}
          style={{...cellStyle,visibility:adding?'hidden':'visible',boxSizing:'border-box',fontSize:14,padding:'8px 10px'}}>
          <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:0,color:value?'#e2e8f0':'#64748b'}}>{value||'Not set'}</span>
        </button>
        <div aria-hidden={!adding} style={{...cellStyle,visibility:adding?'visible':'hidden',display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center'}}>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={e=>setText(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitText();}else if(e.key==='Escape'){cancelText();}}}
            autoComplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellCheck={false}
            aria-label={'New '+label.toLowerCase()}
            placeholder={'New '+label.toLowerCase()}
            tabIndex={adding?0:-1}
            style={{flex:'1 1 0',minWidth:0,height:40,boxSizing:'border-box',padding:'8px 10px',borderRadius:8,border:'1px solid #2d4057',background:'#0f1923',color:'#e2e8f0',fontSize:14,fontFamily:'inherit'}}/>
          <button type="button" tabIndex={adding?0:-1} className="nf-btn nf-btn--primary nf-btn--sm" onClick={commitText} style={{height:40,flex:'0 0 auto'}}>Use</button>
          <button type="button" tabIndex={adding?0:-1} className="nf-btn nf-btn--ghost nf-btn--sm" onClick={cancelText} style={{height:40,flex:'0 0 auto'}}>Cancel</button>
        </div>
      </div>
      {open&&(
        <ul ref={listRef} role="listbox" aria-label={label} style={{position:'absolute',left:0,right:0,top:'100%',marginTop:4,zIndex:30,listStyle:'none',margin:'4px 0 0',padding:4,boxSizing:'border-box',maxHeight:260,overflowY:'auto',overflowX:'hidden',background:'#0f1923',border:'1px solid #2d4057',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,0.5)'}}>
          {value&&(
            <li role="presentation"><button type="button" role="option" aria-selected={false} className="nf-menu__item" onClick={()=>{onPick(null);setOpen(false);}} style={menuItemStyle}>Not set</button></li>
          )}
          {choices.map(o=>(
            <li key={o} role="presentation"><button type="button" role="option" aria-selected={false} className="nf-menu__item" onClick={()=>{onPick(o);setOpen(false);}} style={menuItemStyle}>{o}</button></li>
          ))}
          <li role="presentation"><button type="button" role="option" aria-selected={false} className="nf-menu__item" onClick={()=>{setOpen(false);setAdding(true);}} style={{...menuItemStyle,color:'#60a5fa'}}>Add new...</button></li>
        </ul>
      )}
    </div>
  );
}

const menuItemStyle={width:'100%',minWidth:0,boxSizing:'border-box',whiteSpace:'normal',overflowWrap:'anywhere',textAlign:'left',background:'transparent',border:'none',color:'#e2e8f0',fontSize:14,fontFamily:'inherit',padding:'9px 10px'};

// The venue form. value is the venue now recorded (or null); options holds the list for each field.
// onSave(venue, added) receives the normalized venue and the values typed by hand; onSecondary is Skip or Cancel.
// locked keeps the dealer as recorded (an ended session with later dealer changes). dealerFromSpin is the spin
// index a dealer change would start from, or null when the session is not live.
function VenuePicker({title,value,options,locked,dealerFromSpin,saveLabel,secondaryLabel,onSave,onSecondary}) {
  const start=normalizeVenue(value)||{};
  const [draft,setDraft]=React.useState(()=>({...start}));
  const [added,setAdded]=React.useState([]);
  const kind=draft.kind||null;
  const opts=options||{};
  const dealerChanged=kind==='table'&&!locked&&(draft.dealer||null)!==(start.dealer||null);
  const note=locked
    ? 'Dealer changes after the start are kept as recorded.'
    : dealerChanged&&start.dealer&&dealerFromSpin!=null
      ? 'Dealer change recorded from spin '+(dealerFromSpin+1)+'.'
      : ' ';

  function setField(key){
    return v=>setDraft(d=>{
      const next={...d};
      if(v===null||v===undefined)delete next[key];
      else next[key]=v;
      return next;
    });
  }
  function addField(key){
    return text=>{
      setDraft(d=>({...d,[key]:text}));
      setAdded(a=>a.concat([{field:key,value:text}]));
    };
  }
  function setKind(k){setDraft(d=>{const next={...d};if(next.kind===k)delete next.kind;else next.kind=k;return next;});}

  const segStyle=on=>({flex:'1 1 0',minWidth:0,height:40,boxSizing:'border-box',borderRadius:10,border:'2px solid '+(on?'#16a34a':'#2d4057'),background:on?'#134e2a':'#1e2d3d',color:on?'#86efac':'#94a3b8',fontSize:13,fontWeight:700,cursor:'pointer'});
  const groupStyle={gridArea:'1 / 1',minWidth:0,display:'flex',flexDirection:'column',gap:12};

  return (
    <section aria-label={title} style={{display:'flex',flexDirection:'column',gap:12,width:'100%',minWidth:0,boxSizing:'border-box'}}>
      <div style={{fontSize:16,fontWeight:800,color:'#e2e8f0'}}>{title}</div>
      <VenueValueField field="casino" value={draft.casino} options={opts.casino} onPick={setField('casino')} onAdd={addField('casino')}/>
      <div role="group" aria-label="Venue kind" style={{display:'flex',gap:8,minWidth:0}}>
        <button type="button" aria-pressed={kind==='machine'} style={segStyle(kind==='machine')} onClick={()=>setKind('machine')}>Machine</button>
        <button type="button" aria-pressed={kind==='table'} style={segStyle(kind==='table')} onClick={()=>setKind('table')}>Table</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',minWidth:0}}>
        <div aria-hidden={kind!==null} style={{...groupStyle,visibility:kind===null?'visible':'hidden'}}>
          <div style={{fontSize:12,color:'#64748b',minHeight:40,display:'flex',alignItems:'center'}}>Choose machine or table to add the details.</div>
        </div>
        <div aria-hidden={kind!=='machine'} style={{...groupStyle,visibility:kind==='machine'?'visible':'hidden'}}>
          <VenueValueField field="maker" value={draft.maker} options={opts.maker} disabled={kind!=='machine'} onPick={setField('maker')} onAdd={addField('maker')}/>
          <VenueValueField field="model" value={draft.model} options={opts.model} disabled={kind!=='machine'} onPick={setField('model')} onAdd={addField('model')}/>
          <VenueValueField field="version" value={draft.version} options={opts.version} disabled={kind!=='machine'} onPick={setField('version')} onAdd={addField('version')}/>
        </div>
        <div aria-hidden={kind!=='table'} style={{...groupStyle,visibility:kind==='table'?'visible':'hidden'}}>
          <VenueValueField field="table" value={draft.table} options={opts.table} disabled={kind!=='table'} onPick={setField('table')} onAdd={addField('table')}/>
          <VenueValueField field="dealer" value={draft.dealer} options={opts.dealer} disabled={kind!=='table'||locked} onPick={setField('dealer')} onAdd={addField('dealer')}/>
        </div>
      </div>
      <div aria-live="polite" style={{minHeight:16,fontSize:11,color:'#94a3b8',lineHeight:'16px'}}>{note}</div>
      <div style={{display:'flex',gap:8,minWidth:0}}>
        {onSecondary&&(
          <button type="button" className="nf-btn nf-btn--ghost nf-btn--lg" onClick={onSecondary} style={{flex:'1 1 0',minWidth:0}}>{secondaryLabel||'Skip'}</button>
        )}
        <button type="button" className="nf-btn nf-btn--primary nf-btn--lg" onClick={()=>onSave(normalizeVenue(draft),added)} style={{flex:'1 1 0',minWidth:0}}>{saveLabel||'Save'}</button>
      </div>
    </section>
  );
}
