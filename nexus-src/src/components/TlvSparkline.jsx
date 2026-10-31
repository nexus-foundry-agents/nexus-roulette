// Hand-drawn SVG line of a TLV series. No chart library. One drawing with two uses: the sparkline inside a section tile
// (no axes, stretched to a fixed box) and the chart in the detail view (axes, the current losing streak shaded, and
// reference lines). The caller sets the size; the drawing scales to it.
// `values` is the series, `startSpin` the spin number of its first value, `shadeFrom` the index of the first value to
// shade (the detail view only), and `refs` the reference lines [{label, value}] (the detail view only).
function TlvSparkline({values, startSpin, shadeFrom, refs, axes, label, width, height, color}) {
  const W = width || 100;
  const H = height || 20;
  const pad = axes ? {l: 26, r: 6, t: 6, b: 16} : {l: 1, r: 1, t: 2, b: 2};
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const vals = values || [];
  const n = vals.length;
  const refList = axes ? (refs || []).filter(r => r && typeof r.value === "number") : [];
  let lo = 0;
  let hi = 1;
  if (n) {
    let mn = vals[0];
    let mx = vals[0];
    for (let i = 1; i < n; i++) {
      if (vals[i] < mn) mn = vals[i];
      if (vals[i] > mx) mx = vals[i];
    }
    if (axes) {
      lo = 0;
      hi = Math.max(1, mx);
      refList.forEach(r => { if (r.value > hi) hi = r.value; });
    } else {
      lo = mn;
      hi = mx > mn ? mx : mn + 1;
    }
  }
  const x = (i) => pad.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => pad.t + innerH - ((v - lo) / (hi - lo)) * innerH;
  const f = (v) => String(Math.round(v * 100) / 100);
  const shaded = axes && n && typeof shadeFrom === "number" && shadeFrom >= 0 && shadeFrom < n;
  const points = n ? vals.map((v, i) => f(x(i)) + "," + f(y(v))).join(" ") : "";
  const last = n ? {cx: x(n - 1), cy: y(vals[n - 1])} : null;
  return (
    <svg role="img" aria-label={label || "TLV"} viewBox={"0 0 " + W + " " + H}
      preserveAspectRatio={axes ? "xMidYMid meet" : "none"}
      style={{display:"block",width:"100%",height:"100%",overflow:"visible"}}>
      {shaded && (
        <rect x={f(x(shadeFrom))} y={f(pad.t)} width={f(Math.max(0, pad.l + innerW - x(shadeFrom)))} height={f(innerH)} fill="#f59e0b" fillOpacity="0.16"/>
      )}
      {refList.map((r, k) => (
        <g key={"ref" + k}>
          <line x1={f(pad.l)} x2={f(pad.l + innerW)} y1={f(y(r.value))} y2={f(y(r.value))} stroke="#64748b" strokeWidth="0.8" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>
          <text x={f(W - pad.r)} y={f(y(r.value) - 2)} textAnchor="end" fontSize="8" fill="#94a3b8">{r.label}</text>
        </g>
      ))}
      {axes && (
        <g fill="#64748b" fontSize="8">
          <text x={f(pad.l - 3)} y={f(y(hi) + 3)} textAnchor="end">{String(Math.round(hi))}</text>
          <text x={f(pad.l - 3)} y={f(y(lo) + 3)} textAnchor="end">{String(Math.round(lo))}</text>
          {n > 0 && <text x={f(pad.l)} y={f(H - 3)} textAnchor="start">{"spin " + (startSpin || 1)}</text>}
          {n > 0 && <text x={f(pad.l + innerW)} y={f(H - 3)} textAnchor="end">{"spin " + ((startSpin || 1) + n - 1)}</text>}
        </g>
      )}
      {n > 0 && (
        <polyline points={points} fill="none" stroke={color || "#e2e8f0"} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      )}
      {last && <circle cx={f(last.cx)} cy={f(last.cy)} r="2" fill={color || "#e2e8f0"}/>}
    </svg>
  );
}
