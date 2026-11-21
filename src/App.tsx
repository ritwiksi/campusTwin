import { useEffect, useRef, useState } from 'react'
import {
  Cartesian2, Cartesian3, ClassificationType, Color,
  createGooglePhotorealistic3DTileset, DistanceDisplayCondition,
  Ion, IonGeocodeProviderType, LabelStyle, Math as CesiumMath,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Viewer, VerticalOrigin
} from 'cesium'

type Building = {
  id: string; name: string; campus: string; use: string; centroid: [number, number];
  polygon: number[][]; levels: number; floor_area_ft2: number; footprint_ft2: number;
  electric_mwh: number; thermal_mmbtu: number; emissions_t: number; roof_cap_kw: number;
  after_emissions_t: number; solar_kw: number; efficiency_tier: number
}
type Totals = { baseline_emissions_t: number; emissions_t: number; avoided_t: number;
  reduction_pct: number; capex_usd: number; annual_savings_usd: number;
  simple_payback_years: number | null; annual_operating_premium_usd: number }
type Evaluation = { buildings: Building[]; summary: Totals }
type Change = { efficiency_tier: number; solar_kw: number }
type Plan = { buildings: Record<string, Change> }
type Opt = { status: string; message: string; plan: Plan; optimized: Evaluation; baseline: Evaluation }
type Config = { parameters: Record<string, {value: string | number; unit: string; tag: string; source: string; vintage: string}>; sources: Record<string, {title: string; url: string; vintage: string}>; caveats: string[]; campus_context: Record<string, string|number> }

const money = (n: number) => n >= 1000000 ? '$' + (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + Math.round(n)
const whole = (n: number) => Math.round(n).toLocaleString('en-US')
const empty: Plan = {buildings: {}}
async function api<T>(route: string, payload?: object): Promise<T> {
  const response = await fetch('/api/' + route, payload ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)} : undefined)
  const data = await response.json()
  if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : 'HTTP ' + response.status)
  return data as T
}

function App() {
  const map = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const [sceneReady, setSceneReady] = useState(false)
  const [sceneError, setSceneError] = useState('')
  const [runtimeToken, setRuntimeToken] = useState(import.meta.env.VITE_CESIUM_ION_TOKEN || '')
  const [buildings, setBuildings] = useState<Building[]>([])
  const [baseline, setBaseline] = useState<Evaluation | null>(null)
  const [manual, setManual] = useState<Evaluation | null>(null)
  const [optimized, setOptimized] = useState<Evaluation | null>(null)
  const [plan, setPlan] = useState<Plan>({buildings:{}})
  const [optPlan, setOptPlan] = useState<Plan>({buildings:{}})
  const [mode, setMode] = useState<'baseline'|'manual'|'optimized'>('baseline')
  const [campus, setCampus] = useState<'Busch'|'Livingston'>('Busch')
  const [selected, setSelected] = useState<string|null>(null)
  const [budget, setBudget] = useState(1000000)
  const [solarPercent, setSolarPercent] = useState(0)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState('')
  const [config, setConfig] = useState<Config|null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)

  const active = mode === 'optimized' ? (optimized || baseline) : mode === 'manual' ? (manual || baseline) : baseline
  const activePlan = mode === 'optimized' ? optPlan : mode === 'manual' ? plan : empty
  const building = buildings.find(b => b.id === selected)
  const buildingNow = active?.buildings.find(b => b.id === selected)
  const change = building ? (plan.buildings[building.id] || {efficiency_tier:0,solar_kw:0}) : {efficiency_tier:0,solar_kw:0}

  useEffect(() => {
    let cancelled = false
    Promise.all([api<Building[]>('buildings'),api<Evaluation>('evaluate',{plan:empty}),api<Config>('config')]).then(([b,e,c]) => {
      if(cancelled)return
      setBuildings(b); setBaseline(e); setManual(e); setConfig(c)
    }).catch(e => {if(!cancelled)setNotice('Backend model unavailable: '+String(e))})
    return () => {cancelled=true}
  }, [])

  useEffect(() => {
    if (runtimeToken) return
    let cancelled = false
    void api<{ cesium_ion_token: string }>('runtime-config')
      .then(result => { if (!cancelled && result.cesium_ion_token) setRuntimeToken(result.cesium_ion_token) })
      .catch(() => { /* Local .env can still supply Vite token */ })
    return () => { cancelled = true }
  }, [runtimeToken])

  useEffect(() => {
    if(!map.current)return
    const token=runtimeToken
    if(!token){setSceneError('Set VITE_CESIUM_ION_TOKEN to show Google 3D tiles. Planner data can still load.');return}
    setSceneError('')
    Ion.defaultAccessToken=token
    const v=new Viewer(map.current,{
      animation:false,baseLayerPicker:false,fullscreenButton:false,
      geocoder:IonGeocodeProviderType.GOOGLE,globe:false,
      homeButton:false,infoBox:false,sceneModePicker:false,selectionIndicator:false,
      timeline:false,navigationHelpButton:false
    })
    viewer.current=v;setSceneReady(true)
    v.scene.screenSpaceCameraController.enableCollisionDetection=false
    let disposed=false
    const handler=new ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((event:{position:Cartesian2})=>{
      const picked=v.scene.drillPick(event.position,12)
      const id=picked.map(p=>p?.id?.id).find(x=>typeof x==='string'&&x.startsWith('building-'))
      if(typeof id==='string')setSelected(id.slice('building-'.length).replace('-label',''))
    },ScreenSpaceEventType.LEFT_CLICK)
    void createGooglePhotorealistic3DTileset({onlyUsingWithGoogleGeocoder:true})
      .then(tiles=>{if(!disposed)v.scene.primitives.add(tiles)})
      .catch(e=>{if(!disposed)setSceneError('Google tiles could not load: '+String(e))})
    v.camera.flyTo({
      destination:Cartesian3.fromDegrees(-74.462,40.524,1750),
      orientation:{heading:CesiumMath.toRadians(304),pitch:CesiumMath.toRadians(-43),roll:0},
      duration:1.4
    })
    return()=>{disposed=true;handler.destroy();viewer.current=null;setSceneReady(false);if(!v.isDestroyed())v.destroy()}
  }, [runtimeToken])

  // Rebuild model overlays after a completed calculation, not during each render frame.
  useEffect(()=>{
    const v=viewer.current
    if(!v||!sceneReady||!active)return
    v.entities.removeAll()
    const maxIntensity=Math.max(...active.buildings.map(b=>b.emissions_t/b.floor_area_ft2))
    for(const b of active.buildings){
      const intensity=(b.after_emissions_t/b.floor_area_ft2)/(maxIntensity||1)
      const c=Color.fromCssColorString(intensity>.7?'#d8796a':intensity>.38?'#d9ab67':'#55c3a6')
      v.entities.add({
        id:'building-'+b.id,
        polygon:{hierarchy:Cartesian3.fromDegreesArray(b.polygon.flat()),material:c.withAlpha(b.id===selected?.8:.53),classificationType:ClassificationType.CESIUM_3D_TILE}
      })
      v.entities.add({
        id:'building-'+b.id+'-label',
        position:Cartesian3.fromDegrees(b.centroid[0],b.centroid[1],b.levels*4+13),
        label:{text:b.name.length>29?b.name.slice(0,27)+'…':b.name,font:'12px Arial',fillColor:Color.WHITE,
          outlineColor:Color.BLACK,outlineWidth:1,style:LabelStyle.FILL_AND_OUTLINE,
          showBackground:true,backgroundColor:Color.fromCssColorString('#0c262e').withAlpha(.83),
          backgroundPadding:new Cartesian2(8,5),verticalOrigin:VerticalOrigin.BOTTOM,
          distanceDisplayCondition:new DistanceDisplayCondition(0,1550)}
      })
      const solar=activePlan.buildings[b.id]?.solar_kw||0
      if(solar>.1){
        const poly=b.polygon.map(p=>[b.centroid[0]+(p[0]-b.centroid[0])*.57,b.centroid[1]+(p[1]-b.centroid[1])*.57])
        v.entities.add({polygon:{hierarchy:Cartesian3.fromDegreesArray(poly.flat()),material:Color.fromCssColorString('#3987c7').withAlpha(.72),classificationType:ClassificationType.CESIUM_3D_TILE}})
      }
    }
  },[active,activePlan,selected,sceneReady])

  const fly=(point:[number,number],height:number)=>{
    viewer.current?.camera.flyTo({
      destination:Cartesian3.fromDegrees(point[0],point[1],height),
      orientation:{heading:CesiumMath.toRadians(312),pitch:CesiumMath.toRadians(-48),roll:0},
      duration:1.15
    })
  }
  const chooseBuilding=(b:Building)=>{
    setSelected(b.id);setCampus(b.campus as 'Busch'|'Livingston')
    setSolarPercent(Math.round(100*(plan.buildings[b.id]?.solar_kw||0)/b.roof_cap_kw))
    fly(b.centroid,600)
  }
  const chooseCampus=(c:'Busch'|'Livingston')=>{
    setCampus(c);setSelected(null)
    fly(c==='Busch'?[-74.462,40.524]:[-74.440,40.5235],2200)
  }
  const edit=async(partial:Partial<Change>)=>{
    if(!building)return
    const p:Plan={buildings:{...plan.buildings,[building.id]:{...change,...partial}}}
    setWorking(true);setNotice('')
    try{const r=await api<Evaluation>('evaluate',{plan:p});setManual(r);setPlan(p);setMode('manual')}
    catch(e){setNotice('Evaluate failed: '+String(e))}
    finally{setWorking(false)}
  }
  const optimize=async()=>{
    setWorking(true);setNotice('')
    try{
      const r=await api<{status:string;message:string;plan:Plan;optimized:Evaluation}>('optimize',{budget_usd:budget,objective:'max_avoided',include_procurement:false})
      setNotice('Solver: '+r.status+' · '+r.message)
      if(r.status==='optimal'){setOptimized(r.optimized);setOptPlan(r.plan);setMode('optimized')}
    }catch(e){setNotice('Optimization failed: '+String(e))}
    finally{setWorking(false)}
  }
  const samples=buildings.filter(b=>b.campus===campus)
  return <div className="app">
    <div className="scene" ref={map}/>
    {!sceneReady&&<div className="placeholder"><div className="map-grid"/><div className="map-target">◎<small>BUSCH / LIVINGSTON</small><strong>3D CAMPUS LAYER</strong></div></div>}
    <div className="vignette"/>
    <header className="header">
      <div className="brand"><div className="mark">R<span>/</span></div><div><strong>RUTGERS TWIN</strong><small>CAMPUS DECARBONIZATION STUDIO</small></div></div>
      <div className="header-actions"><span>● HISTORICAL MODEL · FY2019</span><button onClick={()=>setContextOpen(!contextOpen)}>Campus context</button><button onClick={()=>setSourcesOpen(true)}>Sources & assumptions ↗</button></div>
    </header>
    <nav className="campuses">{(['Busch','Livingston'] as const).map(c=><button className={campus===c?'chosen':''} onClick={()=>chooseCampus(c)} key={c}>{c}</button>)}</nav>
    <aside className="planner pane">
      <div className="eyebrow">01 / STRATEGY STUDIO</div>
      <h1>Every tonne<br/>is a decision<span>.</span></h1>
      <p className="description">Map a campus. Explore decarbonization interventions. Challenge the optimizer to find a better allocation.</p>
      <div className="rule"/>
      <div className="metric-head">ANNUAL EMISSIONS <span>MODELED ESTIMATE</span></div>
      <div className="metric">{active?whole(active.summary.emissions_t):'—'} <small>tCO₂e</small></div>
      <div className="progress"><div style={{width:active?100*active.summary.emissions_t/(baseline?.summary.emissions_t||1)+'%':'100%'}}/></div>
      <div className="reduction">{active?whole(active.summary.avoided_t)+' tonnes avoided · '+active.summary.reduction_pct.toFixed(1)+'% reduction':'15 buildings · sample only'}</div>
      <div className="triplet">
        <div>CAPITAL<strong>{active?money(active.summary.capex_usd):'—'}</strong></div>
        <div>ANNUAL SAVINGS<strong>{active?money(active.summary.annual_savings_usd):'—'}</strong></div>
        <div>PAYBACK<strong>{active?.summary.simple_payback_years==null?'—':active.summary.simple_payback_years.toFixed(1)+' yr'}</strong></div>
      </div>
      <div className="rule"/>
      <div className="eyebrow">02 / ALLOCATE CAPITAL</div>
      <div className="budget-line"><span>Investment budget</span><strong>{money(budget)}</strong></div>
      <input aria-label="Investment budget" type="range" min={0} max={5000000} step={50000} value={budget} onChange={e=>setBudget(Number(e.target.value))}/>
      <button className="primary" disabled={working||!baseline} onClick={optimize}>{working?'Calculating allocation…':'✦ Optimize decarbonization'} <span>↗</span></button>
      <p className="fine">Exact MILP for this simplified model. Physical building upgrades only; energy procurement excluded to avoid zero-capital loopholes.</p>
      {notice&&<div className="notice">{notice}</div>}
    </aside>
    <aside className="catalog pane">
      <div className="eyebrow">03 / BUILDING EXPLORER <span>{samples.length} SITES</span></div>
      <div className="catalog-rows">{samples.map(b=><button key={b.id} className={selected===b.id?'selected':''} onClick={()=>chooseBuilding(b)}><i/>{b.name}<span>↗</span></button>)}</div>
    </aside>
    {building&&<aside className="detail pane">
      <button className="close" onClick={()=>setSelected(null)}>×</button>
      <div className="eyebrow">{building.campus.toUpperCase()} / BUILDING</div>
      <h2>{building.name}</h2>
      <p>{building.use} · {whole(building.floor_area_ft2)} ft² estimated floor area</p>
      <span className="estimate">MODELED ESTIMATE</span>
      <div className="detail-number">{buildingNow?(buildingNow.after_emissions_t).toFixed(1):building.emissions_t.toFixed(1)} <small>tCO₂e / yr</small></div>
      <div className="detail-duo"><div>ELECTRICITY<strong>{whole(building.electric_mwh)} MWh</strong></div><div>THERMAL<strong>{whole(building.thermal_mmbtu)} MMBtu</strong></div></div>
      <div className="rule"/>
      <div className="eyebrow">YOUR INTERVENTIONS</div>
      <label htmlFor="retrofit">Efficiency retrofit</label>
      <select id="retrofit" value={change.efficiency_tier} onChange={e=>void edit({efficiency_tier:Number(e.target.value)})}><option value={0}>No retrofit</option><option value={1}>Tier 1 · 15%</option><option value={2}>Tier 2 · deep retrofit</option></select>
      <div className="budget-line">Rooftop solar <strong>{(building.roof_cap_kw*solarPercent/100).toFixed(1)} kW</strong></div>
      <input aria-label="Rooftop solar capacity" type="range" min={0} max={100} step={5} value={solarPercent} onChange={e=>setSolarPercent(Number(e.target.value))} onPointerUp={()=>void edit({solar_kw:building.roof_cap_kw*solarPercent/100})} onKeyUp={()=>void edit({solar_kw:building.roof_cap_kw*solarPercent/100})}/>
      <p className="fine">Solar potential and floor count are estimated, not measured. Blue map overlay is schematic.</p>
      <button className="secondary" onClick={()=>setMode('manual')}>View manual plan →</button>
    </aside>}
    <div className="comparison pane">
      <div className="eyebrow">SCENARIO COMPARISON <span>CLICK TO PREVIEW</span></div>
      <div className="comparison-cards">{([['Baseline',baseline,'baseline'],['Your plan',manual,'manual'],['Optimized',optimized,'optimized']] as const).map(([label,data,id])=><button key={id} disabled={!data} className={mode===id?'selected':''} onClick={()=>setMode(id)}><span>{label}</span><strong>{data?whole(data.summary.emissions_t):'—'} <small>t</small></strong><em>{id==='baseline'?'REFERENCE':data?'-'+data.summary.reduction_pct.toFixed(1)+'%':'NOT RUN'}</em></button>)}</div>
      <p className="fine">Annual modeled sample · not measured building bills</p>
    </div>
    <div className="legend">EMISSIONS INTENSITY <div><i/><i/><i/></div>LOW → HIGH</div>
    {sceneError&&<div className="tile-alert">{sceneError}</div>}
    {contextOpen&&config&&<aside className="context pane"><button className="close" onClick={()=>setContextOpen(false)}>×</button><div className="eyebrow">RUTGERS / HISTORICAL CONTEXT</div><h2>Real climate commitments.</h2><p>Busch + Livingston EUI: 161 kBtu/ft²/year. Rutgers building emissions baseline: 359,541 tCO₂e (university-wide, historical).</p><p>FY2018 B/L electricity used: 170.5 GWh; gas 16.05M therms. Figures include cogeneration, so they cannot simply be summed.</p><p>These are campus facts, NOT measurements of the modeled building sample.</p></aside>}
    {sourcesOpen&&config&&<div className="scrim" onClick={()=>setSourcesOpen(false)}><aside className="source-drawer" onClick={e=>e.stopPropagation()}>
      <button className="close" onClick={()=>setSourcesOpen(false)}>×</button><div className="eyebrow">MODEL / AUDIT TRAIL</div><h2>Sources & assumptions</h2>
      <p>Preliminary planning tool, not an engineering study. All individual buildings are modeled estimates.</p>
      <h3>PARAMETER REGISTER</h3>{Object.entries(config.parameters).map(([key,p])=><div key={key} className="param"><div><strong>{key.replaceAll('_',' ')}</strong><small>{p.value} {p.unit}</small></div><b className={p.tag.toLowerCase()}>{p.tag}</b><small>{p.source} · {p.vintage}</small></div>)}
      <h3>SOURCES</h3>{Object.entries(config.sources).map(([key,s])=><a key={key} href={s.url} target="_blank" rel="noreferrer">{s.title} ↗<small>{s.vintage}</small></a>)}
      <h3>LIMITATIONS</h3>{config.caveats.map((c,i)=><p key={i}>• {c}</p>)}
    </aside></div>}
    <footer>RUTGERS TWIN <span>PRELIMINARY PLANNING TOOL · NOT AN ENGINEERING STUDY</span><span>HISTORICAL DATA / 2017–2021</span></footer>
  </div>
}
export default App
