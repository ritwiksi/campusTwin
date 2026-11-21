import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoundingSphere, Cartesian2, Cartesian3, ClassificationType, Color, ColorMaterialProperty,
  createGooglePhotorealistic3DTileset, DistanceDisplayCondition,
  Entity, HeadingPitchRange, Ion, IonGeocodeProviderType, LabelStyle, Math as CesiumMath,
  NearFarScalar, PolygonHierarchy, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Viewer, VerticalOrigin
} from 'cesium'

type Building = {
  id: string; name: string; campus: string; use: string; centroid: [number, number];
  polygon: number[][]; levels: number; floor_area_ft2: number; footprint_ft2: number;
  electric_mwh: number; electric_after_mwh: number; thermal_mmbtu: number; emissions_t: number; roof_cap_kw: number;
  after_emissions_t: number; solar_kw: number; efficiency_tier: number
}
type Totals = { baseline_emissions_t: number; emissions_t: number; avoided_t: number;
  reduction_pct: number; capex_usd: number; annual_savings_usd: number;
  simple_payback_years: number | null; annual_operating_premium_usd: number }
type Evaluation = { buildings: Building[]; summary: Totals }
type Change = { efficiency_tier: number; solar_kw: number }
type Plan = { buildings: Record<string, Change> }
type Mode = 'reality' | 'energy'
type Scenario = 'baseline' | 'manual' | 'optimized'
type Campus = 'Busch' | 'Livingston' | 'College Avenue'

const EMPTY: Plan = { buildings: {} }
const CAMPUSES: { name: Campus; center: [number,number]; height: number }[] = [
  { name: 'Busch', center: [-74.462, 40.524], height: 1250 },
  { name: 'Livingston', center: [-74.4406, 40.5229], height: 1280 },
  { name: 'College Avenue', center: [-74.4494, 40.5020], height: 1200 },
]
const START = Date.UTC(2018, 8, 1)
const TOTAL_FRAMES = 91 * 96
const PLAY_MS = 180
const whole = (n: number) => Math.round(n).toLocaleString('en-US')
const dollars = (n: number) => n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'm' : n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : '$' + Math.round(n)

async function api<T>(route: string, payload?: object): Promise<T> {
  const response = await fetch('/api/' + route, payload
    ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}
    : undefined)
  const data = await response.json()
  if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : 'HTTP ' + response.status)
  return data as T
}

// A transparent synthetic demand shape derived from annual modeled electricity.
// This is NOT Rutgers 15-minute meter data. The same time profile is applied to all scenarios.
function demandKW(building: Building, frame: number, scenarioElectricMwh?: number): number {
  const date = new Date(START + Math.floor(frame / 96) * 86400000)
  const hour = (frame % 96) / 4
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6
  const housing = /housing|residence|dorm/i.test(building.use)
  const lab = /research|laboratory|science|engineering/i.test(building.use)
  const occupancy = housing
    ? 0.88 + 0.22 * Math.cos((hour - 21) * Math.PI / 12)
    : lab
      ? 0.83 + 0.27 * Math.cos((hour - 14) * Math.PI / 12)
      : 0.70 + 0.43 * Math.cos((hour - 14) * Math.PI / 12)
  const weekdayFactor = weekend ? (housing ? 1.02 : lab ? 0.92 : 0.72) : 1.03
  const seasonalFactor = date.getUTCMonth() === 8 ? 1.08 : date.getUTCMonth() === 9 ? 0.94 : 1.02
  const energy = scenarioElectricMwh ?? building.electric_mwh
  return Math.max(0, energy * 1000 / 8760 * occupancy * weekdayFactor * seasonalFactor)
}

function App() {
  const map = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const energyPolygons = useRef<Map<string, Entity>>(new Map())
  const solarPolygons = useRef<Map<string, Entity>>(new Map())
  const modeRef = useRef<Mode>('reality')

  const [ready, setReady] = useState(false)
  const [token, setToken] = useState(import.meta.env.VITE_CESIUM_ION_TOKEN || '')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [buildings, setBuildings] = useState<Building[]>([])
  const [baseline, setBaseline] = useState<Evaluation | null>(null)
  const [manual, setManual] = useState<Evaluation | null>(null)
  const [optimized, setOptimized] = useState<Evaluation | null>(null)
  const [plan, setPlan] = useState<Plan>(EMPTY)
  const [optPlan, setOptPlan] = useState<Plan>(EMPTY)
  const [mode, setMode] = useState<Mode>('reality')
  const [scenario, setScenario] = useState<Scenario>('baseline')
  const [campus, setCampus] = useState<Campus>('Busch')
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [budget, setBudget] = useState(1000000)
  const [working, setWorking] = useState(false)
  const [solarPercent, setSolarPercent] = useState(0)
  const [frame, setFrame] = useState(13 * 96 + 48)
  const [playing, setPlaying] = useState(false)

  const active = scenario === 'optimized' ? (optimized || baseline) :
    scenario === 'manual' ? (manual || baseline) : baseline
  const activePlan = scenario === 'optimized' ? optPlan : scenario === 'manual' ? plan : EMPTY
  const currentBuilding = buildings.find(b => b.id === selected)
  const currentState = active?.buildings.find(b => b.id === selected)
  const change = currentBuilding ? (plan.buildings[currentBuilding.id] || {efficiency_tier:0,solar_kw:0}) : {efficiency_tier:0,solar_kw:0}

  const currentDate = useMemo(() => new Date(START + Math.floor(frame / 96) * 86400000), [frame])
  const dateLabel = currentDate.toLocaleDateString('en-US', {timeZone:'UTC',month:'short',day:'numeric',year:'numeric'})
  const h = Math.floor((frame % 96) / 4)
  const minutes = ((frame % 4) * 15)
  const timeLabel = String(h).padStart(2,'0') + ':' + String(minutes).padStart(2,'0')
  const campusRows = active?.buildings.filter(b => b.campus === campus) || []
  const visibleRows = campusRows.filter(b => b.name.toLowerCase().includes(search.trim().toLowerCase()))
  const campusDemand = campusRows.reduce((sum,b)=>sum+demandKW(b,frame,b.electric_after_mwh),0)
  const campusEmissions = campusRows.reduce((sum,b)=>sum+b.after_emissions_t,0)
  const campusBaseline = campusRows.reduce((sum,b)=>sum+b.emissions_t,0)
  const campusReduction = campusBaseline>0 ? 100*(campusBaseline-campusEmissions)/campusBaseline : 0
  const selectedDemand = currentState ? demandKW(currentState,frame,currentState.electric_after_mwh) : 0

  useEffect(() => {
    let cancelled = false
    Promise.all([api<Building[]>('buildings'), api<Evaluation>('evaluate',{plan:EMPTY})])
      .then(([b,e]) => {if(!cancelled){setBuildings(b);setBaseline(e);setManual(e)}})
      .catch(e => {if(!cancelled)setNotice('Energy model unavailable: '+String(e))})
    return () => {cancelled=true}
  }, [])

  useEffect(() => {
    if(token)return
    let cancelled=false
    void api<{cesium_ion_token:string}>('runtime-config')
      .then(r=>{if(!cancelled && r.cesium_ion_token)setToken(r.cesium_ion_token)})
      .catch(()=>{})
    return()=>{cancelled=true}
  }, [token])

  useEffect(() => {
    if(!map.current)return
    if(!token){setError('Cesium token not configured');return}
    setError('')
    Ion.defaultAccessToken=token
    const v=new Viewer(map.current,{
      animation:false,baseLayerPicker:false,fullscreenButton:false,
      geocoder:IonGeocodeProviderType.GOOGLE,globe:false,
      homeButton:false,infoBox:false,sceneModePicker:false,
      selectionIndicator:false,timeline:false,navigationHelpButton:false
    })
    viewer.current=v
    setReady(true)
    v.scene.screenSpaceCameraController.enableCollisionDetection=false
    let disposed=false
    const picker=new ScreenSpaceEventHandler(v.scene.canvas)
    picker.setInputAction((event:{position:Cartesian2})=>{
      const picks=v.scene.drillPick(event.position,12)
      const id=picks.map(p=>p?.id?.id).find(x=>typeof x==='string' && (x.startsWith('label-')||x.startsWith('energy-')))
      if(typeof id==='string')setSelected(id.replace(/^(label-|energy-)/,''))
    },ScreenSpaceEventType.LEFT_CLICK)
    void createGooglePhotorealistic3DTileset({onlyUsingWithGoogleGeocoder:true})
      .then(tiles=>{if(!disposed)v.scene.primitives.add(tiles)})
      .catch(e=>{if(!disposed)setError('3D tiles unavailable: '+String(e))})
    // Target the campus center rather than looking away from a camera positioned at its center.
    v.camera.flyToBoundingSphere(
      new BoundingSphere(Cartesian3.fromDegrees(-74.462,40.524),120),
      {offset:new HeadingPitchRange(CesiumMath.toRadians(304),CesiumMath.toRadians(-55),1050),duration:1.2}
    )
    return()=>{
      disposed=true;picker.destroy();energyPolygons.current.clear();solarPolygons.current.clear()
      viewer.current=null;setReady(false);if(!v.isDestroyed())v.destroy()
    }
  }, [token])

  // Labels are present in Reality and Energy, exactly as in Temple Twin.
  useEffect(()=>{
    const v=viewer.current
    if(!v || !ready || buildings.length===0)return
    v.entities.removeAll()
    energyPolygons.current.clear()
    solarPolygons.current.clear()
    for(const b of buildings){
      const polygon=v.entities.add({
        id:'energy-'+b.id,name:b.name,show:modeRef.current==='energy',
        polygon:{
          hierarchy:new PolygonHierarchy(Cartesian3.fromDegreesArray(b.polygon.flat())),
          material:new ColorMaterialProperty(Color.fromCssColorString('#6fbd87').withAlpha(.64)),
          classificationType:ClassificationType.CESIUM_3D_TILE
        }
      })
      energyPolygons.current.set(b.id,polygon)
      v.entities.add({
        id:'label-'+b.id,
        position:Cartesian3.fromDegrees(b.centroid[0],b.centroid[1],b.levels*4+7),
        label:{
          text:b.name.replace(/\s+/g,' ').trim(),font:'600 14px ui-monospace, Menlo, monospace',
          fillColor:Color.fromCssColorString('#244236'),
          outlineColor:Color.fromCssColorString('#f7f8f4'),
          outlineWidth:1,style:LabelStyle.FILL_AND_OUTLINE,
          showBackground:true,backgroundColor:Color.fromCssColorString('#f7f8f4').withAlpha(.98),
          backgroundPadding:new Cartesian2(9,6),verticalOrigin:VerticalOrigin.BOTTOM,
          pixelOffset:new Cartesian2(0,-8),
          scaleByDistance:new NearFarScalar(220,1,1800,.75),
          translucencyByDistance:new NearFarScalar(1000,1,2000,.24),
          distanceDisplayCondition:new DistanceDisplayCondition(0,2200),
          disableDepthTestDistance:Number.POSITIVE_INFINITY
        }
      })
      const coords=b.polygon.flatMap(p=>[
        b.centroid[0]+(p[0]-b.centroid[0])*.63,
        b.centroid[1]+(p[1]-b.centroid[1])*.63
      ])
      solarPolygons.current.set(b.id,v.entities.add({
        id:'solar-'+b.id,name:b.name+' solar',show:false,
        polygon:{
          hierarchy:new PolygonHierarchy(Cartesian3.fromDegreesArray(coords)),
          material:new ColorMaterialProperty(Color.fromCssColorString('#294f65').withAlpha(.90)),
          classificationType:ClassificationType.CESIUM_3D_TILE
        }
      }))
    }
  },[buildings,ready])

  useEffect(()=>{
    modeRef.current=mode
    const showEnergy=mode==='energy'
    for(const b of buildings){
      const polygon=energyPolygons.current.get(b.id)
      if(polygon){
        polygon.show=showEnergy
        const state=active?.buildings.find(row=>row.id===b.id)
        const kw=demandKW(b,frame,state?.electric_after_mwh)
        const intensity=(kw*1000)/Math.max(1,b.floor_area_ft2)
        const css=intensity>5?'#cd6f6f':intensity>3.2?'#cf8a58':intensity>1.9?'#d2b25e':'#6fbd87'
        if(polygon.polygon)polygon.polygon.material=new ColorMaterialProperty(Color.fromCssColorString(css).withAlpha(b.id===selected?.80:.64))
      }
      const solar=solarPolygons.current.get(b.id)
      if(solar)solar.show=showEnergy && (activePlan.buildings[b.id]?.solar_kw||0)>.01
    }
    if(!showEnergy)setPlaying(false)
  },[mode,active,activePlan,buildings,frame,selected])

  useEffect(()=>{
    if(!playing || mode!=='energy')return
    const timer=window.setInterval(()=>setFrame(i=>(i+1)%TOTAL_FRAMES),PLAY_MS)
    return()=>window.clearInterval(timer)
  },[playing,mode])

  const fly=(point:[number,number],height:number)=>{
    const v=viewer.current
    if(!v)return
    v.camera.cancelFlight()
    v.camera.flyToBoundingSphere(
      new BoundingSphere(Cartesian3.fromDegrees(point[0],point[1]),height>700?120:35),
      {offset:new HeadingPitchRange(CesiumMath.toRadians(304),CesiumMath.toRadians(-55),height>700?1050:380),duration:1.0}
    )
  }
  const chooseCampus=(next:Campus)=>{
    setCampus(next);setSelected(null);setSearch('')
    const c=CAMPUSES.find(c=>c.name===next)!
    fly(c.center,c.height)
  }
  const chooseBuilding=(b:Building)=>{
    setSelected(b.id)
    setSolarPercent(Math.round(100*(plan.buildings[b.id]?.solar_kw||0)/Math.max(1,b.roof_cap_kw)))
    fly(b.centroid,460)
  }
  const edit=async(partial:Partial<Change>)=>{
    if(!currentBuilding || working)return
    const p:Plan={buildings:{...plan.buildings,[currentBuilding.id]:{...change,...partial}}}
    setWorking(true);setNotice('')
    try{
      const r=await api<Evaluation>('evaluate',{plan:p})
      setManual(r);setPlan(p);setScenario('manual')
    }catch(e){setNotice('Unable to update: '+String(e))}
    finally{setWorking(false)}
  }
  const optimize=async()=>{
    setWorking(true);setNotice('')
    try{
      const r=await api<{status:string;message:string;plan:Plan;optimized:Evaluation}>('optimize',{
        budget_usd:budget,objective:'max_avoided',include_procurement:false
      })
      if(r.status==='optimal'){
        setOptimized(r.optimized);setOptPlan(r.plan);setScenario('optimized')
      }else setNotice('Optimization unavailable: '+r.status)
    }catch(e){setNotice('Optimization failed: '+String(e))}
    finally{setWorking(false)}
  }
  const step=(n:number)=>{setPlaying(false);setFrame(i=>(i+n+TOTAL_FRAMES)%TOTAL_FRAMES)}

  return <main className={'app-shell '+(mode==='energy'?'energy-mode':'')}>
    <div ref={map} className="viewer"/>
    <div className="brand-shell">
      <div className="brand-copy">
        <div className="eyebrow">RUTGERS TWIN</div>
        <div className="subtitle">3D Campus Digital Twin</div>
      </div>
    </div>
    <div className="mode-shell">
      <div className="mode-switch" role="group" aria-label="View mode">
        <button className={mode==='reality'?'active':''} onClick={()=>setMode('reality')}>Reality</button>
        <button className={mode==='energy'?'active':''} onClick={()=>setMode('energy')}>Energy</button>
      </div>
    </div>
    <div className="status-shell">
      <div className="status-copy"><strong>{campus}</strong><span>{mode==='energy'?timeLabel+' · modeled':'New Brunswick · NJ'}</span></div>
      <button className="reset-view-button" onClick={()=>chooseCampus(campus)}>Reset view</button>
    </div>
    <nav className="rutgers-campuses" aria-label="Campus">
      {CAMPUSES.map(c=><button key={c.name} className={campus===c.name?'active':''} onClick={()=>chooseCampus(c.name)}>{c.name}</button>)}
    </nav>

    {mode==='energy'&&<>
      <aside className="energy-dock rutgers-dock" aria-label="Energy explorer">
        {currentBuilding && currentState ? <>
          <div className="detail-head">
            <div><div className="dock-kicker">{currentBuilding.campus}</div><div className="detail-title">{currentBuilding.name}</div></div>
            <button className="detail-close" onClick={()=>setSelected(null)} aria-label="Close building">×</button>
          </div>
          <div className="rutgers-detail-summary">
            <span>Modeled demand · {timeLabel}</span>
            <strong>{whole(selectedDemand)} <small>kW</small></strong>
          </div>
          <div className="metric-line"><span>Annual emissions</span><strong>{whole(currentState.after_emissions_t)} tCO₂e</strong></div>
          <div className="metric-line"><span>Annual electricity</span><strong>{whole(currentState.electric_after_mwh)} MWh</strong></div>
          <div className="metric-line"><span>Floor area · estimated</span><strong>{whole(currentBuilding.floor_area_ft2)} ft²</strong></div>
          <div className="rutgers-input-group">
            <label htmlFor="efficiency">Efficiency retrofit</label>
            <select id="efficiency" value={change.efficiency_tier} disabled={working} onChange={e=>void edit({efficiency_tier:Number(e.target.value)})}>
              <option value={0}>None</option>
              <option value={1}>Standard</option>
              <option value={2}>Deep</option>
            </select>
            <div className="rutgers-slider-header"><label htmlFor="roof-solar">Rooftop solar</label><strong>{Math.round(currentBuilding.roof_cap_kw*solarPercent/100)} kW</strong></div>
            <input id="roof-solar" aria-label="Rooftop solar capacity" type="range" min={0} max={100} step={5} disabled={working}
              value={solarPercent} onChange={e=>setSolarPercent(Number(e.target.value))}
              onPointerUp={e=>void edit({solar_kw:currentBuilding.roof_cap_kw*Number(e.currentTarget.value)/100})}
              onKeyUp={e=>void edit({solar_kw:currentBuilding.roof_cap_kw*Number(e.currentTarget.value)/100})}/>
          </div>
          <div className="rutgers-detail-foot">Modeled estimates, not metered readings</div>
          {notice&&<p className="rutgers-notice">{notice}</p>}
          <button className="rutgers-back" onClick={()=>setSelected(null)}>All buildings</button>
        </>:<>
          <div className="dock-head"><div><div className="dock-kicker">energy overview</div><div className="dock-title">{campus} · {campusRows.length} buildings</div></div></div>
          <div className="rutgers-summary">
            <div><span>Annual emissions · {campus}</span><strong>{active?whole(campusEmissions):'—'} <small>tCO₂e</small></strong></div>
            <div><span>Reduction</span><strong>{active?campusReduction.toFixed(1)+'%':'—'}</strong></div>
          </div>
          <div className="rutgers-scenarios" role="group" aria-label="Scenario">
            <button className={scenario==='baseline'?'active':''} onClick={()=>setScenario('baseline')}>Baseline</button>
            <button className={scenario==='manual'?'active':''} onClick={()=>setScenario('manual')}>My plan</button>
            <button className={scenario==='optimized'?'active':''} disabled={!optimized} onClick={()=>setScenario('optimized')}>Optimized</button>
          </div>
          <div className="rutgers-budget">
            <div className="rutgers-slider-header"><label htmlFor="budget">Investment budget</label><strong>{dollars(budget)}</strong></div>
            <input id="budget" type="range" min={0} max={5000000} step={50000} value={budget} onChange={e=>setBudget(Number(e.target.value))}/>
            <button className="rutgers-optimize" disabled={!baseline||working} onClick={()=>void optimize()}>{working?'Optimizing…':'Optimize upgrades'}</button>
          </div>
          {notice&&<p className="rutgers-notice">{notice}</p>}
          <div className="building-search"><span className="building-search-icon">⌕</span>
            <input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search buildings" aria-label="Search campus buildings"/>
          </div>
          <div className="building-list rutgers-building-list">
            {visibleRows.map(b=>{
              const instantaneous=demandKW(b,frame,b.electric_after_mwh)
              return <button key={b.id} className="building-row" onClick={()=>chooseBuilding(b)}>
                <div className="building-row-content">
                  <div className="building-row-main"><span className="building-status" style={{background:'#6fbd87'}}/><div><div className="metric-name">{b.name}</div><div className="metric-intensity">{b.use}</div></div></div>
                  <div className="metric-demand"><strong>{whole(instantaneous)}</strong><span> kW</span></div>
                </div>
              </button>
            })}
            {visibleRows.length===0&&<div className="search-empty">No matching buildings</div>}
          </div>
          <div className="rutgers-detail-foot">Modeled annual energy · synthetic 15-min profile</div>
        </>}
      </aside>
      <section className="timeline" aria-label="Modeled energy timeline">
        <button type="button" className="icon-button" onClick={()=>step(-1)} aria-label="Previous 15 minutes">‹</button>
        <button type="button" className="play-button" onClick={()=>setPlaying(p=>!p)} aria-label={playing?'Pause':'Play'}>{playing?'❚❚':'▶'}</button>
        <div className="timeline-main">
          <div className="timeline-header timeline-header-centered">
            <strong>{dateLabel} · {timeLabel}</strong>
            <span className="rutgers-live-kw">{whole(campusDemand)} kW · modeled</span>
          </div>
          <input type="range" min="0" max={TOTAL_FRAMES-1} step="1" value={frame}
            onChange={e=>{setPlaying(false);setFrame(Number(e.target.value))}} aria-label="Modeled 15-minute interval"/>
        </div>
        <button type="button" className="icon-button" onClick={()=>step(1)} aria-label="Next 15 minutes">›</button>
      </section>
    </>}
    {error&&<div className="error-banner">{error}</div>}
  </main>
}
export default App
