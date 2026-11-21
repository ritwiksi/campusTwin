import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoundingSphere, Cartesian2, Cartesian3, Cartographic, ClassificationType, Color, ColorMaterialProperty,
  createGooglePhotorealistic3DTileset,
  Entity, HeadingPitchRange, Ion, IonGeocodeProviderType, Math as CesiumMath,
  PolygonHierarchy, SceneTransforms, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Viewer
} from 'cesium'
import {getLoadZScore, getLoadAnomalyColor, getLoadAnomalyStatusColor} from './config/energy'
import {START,TOTAL_FRAMES} from './config/demand'
import {componentsKW, type ComstockDataset, type EndUses} from './config/comstock'

type Building = {
  id: string; name: string; campus: string; use: string; comstock_type: string; centroid: [number, number];
  polygon: number[][]; levels: number; floor_area_ft2: number; footprint_ft2: number;
  electric_mwh: number; electric_after_mwh?: number; solar_mwh?: number; thermal_mmbtu: number; emissions_t: number; roof_cap_kw: number;
  after_emissions_t: number; solar_kw: number; solar?: boolean; led?: boolean; hvac?: boolean;
  led_saved_mwh?: number; hvac_saved_mwh?: number; led_reduction_fraction?: number;
  hvac_reduction_fraction?: number; efficiency_tier: number
}
type Totals = { baseline_emissions_t: number; emissions_t: number; avoided_t: number;
  reduction_pct: number; capex_usd: number; annual_savings_usd: number;
  simple_payback_years: number | null; annual_operating_premium_usd: number }
type Evaluation = { buildings: Building[]; summary: Totals }
type Change = { led: boolean; hvac: boolean; solar: boolean }
type Plan = { buildings: Record<string, Change> }
type Mode = 'reality' | 'energy'
type Campus = 'Busch' | 'Livingston' | 'College Avenue'

const EMPTY: Plan = { buildings: {} }
const CAMPUSES: { name: Campus; center: [number,number]; height: number }[] = [
  { name: 'Busch', center: [-74.462, 40.524], height: 1250 },
  { name: 'Livingston', center: [-74.4406, 40.5229], height: 1280 },
  { name: 'College Avenue', center: [-74.4494, 40.5020], height: 1200 },
]
const PLAY_MS = 180
const whole = (n: number) => Math.round(n).toLocaleString('en-US')

async function api<T>(route: string, payload?: object): Promise<T> {
  const response = await fetch('/api/' + route, payload
    ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}
    : undefined)
  const data = await response.json()
  if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : 'HTTP ' + response.status)
  return data as T
}

function App() {
  const map = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const energyPolygons = useRef<Map<string, Entity>>(new Map())
  const solarPolygons = useRef<Map<string, Entity>>(new Map())
  const modeRef = useRef<Mode>('reality')

  const [ready, setReady] = useState(false)
  const [token, setToken] = useState(import.meta.env.VITE_CESIUM_ION_TOKEN || '')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [buildings, setBuildings] = useState<Building[]>([])
  const [comstock, setComstock] = useState<ComstockDataset|null>(null)
  const [baseline, setBaseline] = useState<Evaluation | null>(null)
  const [manual, setManual] = useState<Evaluation | null>(null)
  const [plan, setPlan] = useState<Plan>(EMPTY)
  const [mode, setMode] = useState<Mode>('reality')
  const [campus, setCampus] = useState<Campus>('Busch')
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [working, setWorking] = useState(false)
  const [frame, setFrame] = useState(13 * 96 + 48)
  const [playing, setPlaying] = useState(false)

  const active = manual || baseline
  const currentBuilding = buildings.find(b => b.id === selected)
  const currentState = active?.buildings.find(b => b.id === selected)
  const change:Change = (currentBuilding && plan.buildings[currentBuilding.id]) || {led:false,hvac:false,solar:false}

  const currentDate = useMemo(() => new Date(START + Math.floor(frame / 96) * 86400000), [frame])
  const dateLabel = currentDate.toLocaleDateString('en-US', {timeZone:'UTC',month:'short',day:'numeric',year:'numeric'})
  const h = Math.floor((frame % 96) / 4)
  const minutes = ((frame % 4) * 15)
  const timeLabel = String(h).padStart(2,'0') + ':' + String(minutes).padStart(2,'0')
  const intervalComponents=(b:Building,index:number):EndUses=>comstock
    ? componentsKW(comstock,b,index)
    : {hvac:0,lighting:0,process:0,other:0,total:0}
  const demandKW=(b:Building,index:number)=>intervalComponents(b,index).total
  const campusRows = active?.buildings.filter(b => b.campus === campus) || []
  const visibleRows = campusRows
    .filter(b => b.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a,b)=>demandKW(b,frame)-demandKW(a,frame))
  const campusEmissions = campusRows.reduce((sum,b)=>sum+b.after_emissions_t,0)
  const campusBaseline = campusRows.reduce((sum,b)=>sum+b.emissions_t,0)
  const campusReduction = campusBaseline>0 ? 100*(campusBaseline-campusEmissions)/campusBaseline : 0
  const selectedDemand = currentState ? demandKW(currentState,frame) : 0
  const selectedEndUses = currentState ? intervalComponents(currentState,frame) : null
  // Temple Twin: compare each building's current W/ft² with its own 96-point
  // baseline profile for this date. Do not compare different buildings to each other.
  const dayProfiles=useMemo(()=>{
    const dayStart=Math.floor(frame/96)*96
    return Object.fromEntries(buildings.map(b=>[
      b.id,
      Array.from({length:96},(_,i)=>({
        energy_intensity_w_ft2:demandKW(b,dayStart+i)*1000/Math.max(b.floor_area_ft2,1)
      }))
    ]))
  },[buildings,currentDate,comstock])
  const anomalyScore=(b:Building)=>{
    const actual=active?.buildings.find(x=>x.id===b.id)||b
    const intensity=demandKW(actual,frame)*1000/Math.max(1,b.floor_area_ft2)
    return getLoadZScore(intensity,dayProfiles[b.id]||[])
  }
  const heatColor=(b:Building)=>getLoadAnomalyColor(anomalyScore(b))
  const statusColor=(b:Building)=>getLoadAnomalyStatusColor(anomalyScore(b))

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api<Building[]>('buildings'),
      api<Evaluation>('evaluate',{plan:EMPTY}),
      api<ComstockDataset>('comstock')
    ])
      .then(([b,e,profiles]) => {
        if(!cancelled){setBuildings(b);setBaseline(e);setManual(e);setComstock(profiles)}
      })
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

  // Screen-space building overlays are independent of 3D Tiles classification support.
  // This keeps labels and heat colors visible over Google's photogrammetry tiles.
  useEffect(()=>{
    const v=viewer.current
    const layer=overlay.current
    if(!v || !ready || !layer || buildings.length===0)return
    const local=buildings.filter(b=>b.campus===campus)
    const heightById=new Map<string,number>()
    let count=0
    const update=()=>{
      if(v.isDestroyed())return
      count++
      const width=v.canvas.clientWidth
      const height=v.canvas.clientHeight
      for(const b of local){
        const label=layer.querySelector<HTMLElement>('[data-map-label="'+b.id+'"]')
        const shape=layer.querySelector<SVGPolygonElement>('[data-map-shape="'+b.id+'"]')
        const solarShape=layer.querySelector<SVGPolygonElement>('[data-map-solar="'+b.id+'"]')
        if(!label || !shape)continue
        // Sample rendered 3D tiles at a building center when available.
        // Conservative ellipsoid-height fallback keeps markers visible until tiles stream in.
        if(!heightById.has(b.id) && count%45===0 && v.scene.sampleHeightSupported){
          try{
            const h=v.scene.sampleHeight(Cartographic.fromDegrees(b.centroid[0],b.centroid[1]))
            if(h!==undefined && Number.isFinite(h) && h>-30 && h<300)heightById.set(b.id,h+3)
          }catch{ /* Tiles are still loading */ }
        }
        const z=heightById.get(b.id) ?? Math.max(65,42+b.levels*4)
        const world=Cartesian3.fromDegrees(b.centroid[0],b.centroid[1],z)
        const relative=Cartesian3.subtract(world,v.camera.positionWC,new Cartesian3())
        const distance=Cartesian3.magnitude(relative)
        if(Cartesian3.dot(relative,v.camera.directionWC)<=0 || distance>2250){
          label.style.display='none';shape.style.display='none';if(solarShape)solarShape.style.display='none';continue
        }
        const screen=SceneTransforms.worldToWindowCoordinates(v.scene,world)
        if(!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)){
          label.style.display='none';shape.style.display='none';if(solarShape)solarShape.style.display='none';continue
        }
        label.style.display=(screen.x>-200 && screen.x<width+200 && screen.y>-60 && screen.y<height+60)?'block':'none'
        label.style.left=screen.x+'px'
        label.style.top=screen.y+'px'
        const points:string[]=[]
        for(const p of b.polygon){
          const projected=SceneTransforms.worldToWindowCoordinates(v.scene,Cartesian3.fromDegrees(p[0],p[1],z))
          if(!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y))continue
          points.push(projected.x.toFixed(1)+','+projected.y.toFixed(1))
        }
        if(points.length<3){shape.style.display='none';if(solarShape)solarShape.style.display='none';continue}
        shape.style.display='block'
        shape.setAttribute('points',points.join(' '))
        if(solarShape){
          const insetPoints=points.map(point=>{
            const [x,y]=point.split(',').map(Number)
            return (screen.x+(x-screen.x)*.76).toFixed(1)+','+
              (screen.y+(y-screen.y)*.76).toFixed(1)
          })
          solarShape.style.display='block'
          solarShape.setAttribute('points',insetPoints.join(' '))
        }
      }
    }
    v.scene.postRender.addEventListener(update)
    update()
    return()=>{if(!v.isDestroyed())v.scene.postRender.removeEventListener(update)}
  },[ready,buildings,campus])

  useEffect(()=>{
    modeRef.current=mode
    const showEnergy=mode==='energy'
    for(const b of buildings){
      const polygon=energyPolygons.current.get(b.id)
      if(polygon){
        polygon.show=showEnergy
        const state=active?.buildings.find(row=>row.id===b.id)
        const kw=demandKW(state || b,frame)
        const intensity=kw*1000/Math.max(1,b.floor_area_ft2)
        const css=getLoadAnomalyColor(getLoadZScore(intensity,dayProfiles[b.id]||[]))
        if(polygon.polygon)polygon.polygon.material=new ColorMaterialProperty(Color.fromCssColorString(css).withAlpha(b.id===selected?.80:.64))
      }
      const solar=solarPolygons.current.get(b.id)
      if(solar)solar.show=showEnergy && (active?.buildings.find(row=>row.id===b.id)?.solar_kw||0)>.01
    }
    if(!showEnergy)setPlaying(false)
  },[mode,active,buildings,frame,selected,dayProfiles,comstock])

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
    fly(b.centroid,460)
  }
  const edit=async(partial:Partial<Change>)=>{
    if(!currentBuilding || working)return
    const previous=plan
    const p:Plan={buildings:{...plan.buildings,[currentBuilding.id]:{...change,...partial}}}
    // Update switches immediately; roll them back if the calculation fails.
    setPlan(p)
    setWorking(true);setNotice('')
    try{
      const r=await api<Evaluation>('evaluate',{plan:p})
      setManual(r)
    }catch(e){
      setPlan(previous)
      setNotice('Unable to update: '+String(e))
    }finally{setWorking(false)}
  }
  const step=(n:number)=>{setPlaying(false);setFrame(i=>(i+n+TOTAL_FRAMES)%TOTAL_FRAMES)}

  return <main className={'app-shell '+(mode==='energy'?'energy-mode':'')}>
    <div ref={map} className="viewer"/>
    <div ref={overlay} className="map-overlays">
      <svg className={'map-footprints '+(mode==='energy'?'is-visible':'')} aria-hidden="true">
        <defs>
          <pattern id="campus-solar-panels" patternUnits="userSpaceOnUse" width="18" height="12">
            <rect width="18" height="12" fill="#123047"/>
            <rect x="1" y="1" width="16" height="10" rx="1" fill="#215c81" stroke="#92c3db" strokeWidth=".75"/>
            <path d="M9 1 V11" stroke="#497f9b" strokeWidth=".6"/>
          </pattern>
        </defs>
        {campusRows.map(b=><polygon key={b.id} data-map-shape={b.id}
          fill={heatColor(b)} stroke={heatColor(b)} strokeWidth={2}
          fillOpacity={selected===b.id ? .73 : .42} strokeOpacity={.98}/>)}
        {campusRows.filter(b=>(b.solar_kw||0)>.01).map(b=>
          <polygon key={'solar-'+b.id} className="map-solar-roof" data-map-solar={b.id}
            fill="url(#campus-solar-panels)" stroke="#a9d8ef" strokeWidth={2}
            fillOpacity={.98} strokeOpacity={1}/>)}
      </svg>
      {buildings.filter(b=>b.campus===campus).map(b=><button key={b.id} type="button"
        data-map-label={b.id} className={'map-building-tag '+(selected===b.id?'selected':'')}
        onClick={()=>{chooseBuilding(b);if(mode==='reality')setMode('energy')}}
        title={b.name}><span className="map-tag-dot" style={{background:mode==='energy'?statusColor(b):'#4f7d68'}}/>{b.name}</button>)}
    </div>
    <div className="brand-shell">
      <div className="brand-copy">
        <div className="eyebrow">CAMPUS TWIN</div>
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
      <div className="status-copy"><strong>{campus}</strong><span>{mode==='energy'?dateLabel+' · '+timeLabel:'New Brunswick · NJ'}</span></div>
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
            <span>Demand · {timeLabel}</span>
            <strong>{whole(selectedDemand)} <small>kW</small></strong>
          </div>
          {selectedEndUses&&<div className="rutgers-enduse-grid">
            <div><span>HVAC</span><strong>{whole(selectedEndUses.hvac)} kW</strong></div>
            <div><span>Lighting</span><strong>{whole(selectedEndUses.lighting)} kW</strong></div>
            <div><span>Equipment</span><strong>{whole(selectedEndUses.process)} kW</strong></div>
            <div><span>Other</span><strong>{whole(selectedEndUses.other)} kW</strong></div>
          </div>}
          <div className="metric-line"><span>Annual emissions</span><strong>{whole(currentState.after_emissions_t)} tCO₂e</strong></div>
          <div className="metric-line"><span>Annual grid import</span><strong>{whole(currentState.electric_after_mwh||0)} MWh</strong></div>
          <div className="metric-line"><span>Floor area</span><strong>{whole(currentBuilding.floor_area_ft2)} ft²</strong></div>
          <div className="rutgers-input-group">
            <span className="rutgers-controls-label">Interventions</span>
            <label className="rutgers-toggle">
              <span><strong>LED lighting</strong><small>{change.led ? whole(currentState.led_saved_mwh||0)+' MWh saved/year' : 'Efficient lighting'}</small></span>
              <input type="checkbox" role="switch" aria-label="LED lighting" checked={change.led} disabled={working}
                onChange={e=>void edit({led:e.target.checked})}/>
            </label>
            <label className="rutgers-toggle">
              <span><strong>HVAC controls</strong><small>{change.hvac ? whole(currentState.hvac_saved_mwh||0)+' MWh saved/year' : 'Optimize heating and cooling'}</small></span>
              <input type="checkbox" role="switch" aria-label="HVAC controls" checked={change.hvac} disabled={working}
                onChange={e=>void edit({hvac:e.target.checked})}/>
            </label>
            <label className="rutgers-toggle">
              <span><strong>Rooftop solar</strong><small>{change.solar ? whole(currentState.solar_kw)+' kW installed' : 'Show solar panels on map'}</small></span>
              <input type="checkbox" role="switch" aria-label="Rooftop solar" checked={change.solar} disabled={working}
                onChange={e=>void edit({solar:e.target.checked})}/>
            </label>
          </div>
          {notice&&<p className="rutgers-notice">{notice}</p>}
          <button className="rutgers-back" onClick={()=>setSelected(null)}>All buildings</button>
        </>:<>
          <div className="dock-head"><div><div className="dock-kicker">energy overview</div><div className="dock-title">{campus} · {campusRows.length} buildings</div></div></div>
          <div className="rutgers-summary">
            <div><span>Annual emissions · {campus}</span><strong>{active?whole(campusEmissions):'—'} <small>tCO₂e</small></strong></div>
            <div><span>Reduction</span><strong>{active?campusReduction.toFixed(1)+'%':'—'}</strong></div>
          </div>
          {notice&&<p className="rutgers-notice">{notice}</p>}
          <div className="building-search"><span className="building-search-icon">⌕</span>
            <input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search buildings" aria-label="Search campus buildings"/>
          </div>
          <div className="building-list rutgers-building-list">
            {visibleRows.map(b=>{
              const instantaneous=demandKW(b,frame)
              return <button key={b.id} className="building-row" onClick={()=>chooseBuilding(b)}>
                <div className="building-row-content">
                  <div className="building-row-main"><span className="building-status" style={{background:statusColor(b)}}/><div><div className="metric-name">{b.name}</div><div className="metric-intensity">{(instantaneous*1000/Math.max(b.floor_area_ft2,1)).toFixed(2)} W/ft²</div></div></div>
                  <div className="metric-demand"><strong>{whole(instantaneous)}</strong><span> kW</span></div>
                </div>
              </button>
            })}
            {visibleRows.length===0&&<div className="search-empty">No matching buildings</div>}
          </div>
          
        </>}
        <a className="rutgers-data-link" href="https://github.com/ritwiksi/campusTwin/blob/rutgers-twin/README.md#source-methodology" target="_blank" rel="noreferrer" title="Buildings use estimated annual energy and synthetic interval profiles, not individual Rutgers meter readings">Data methodology</a>
      </aside>
      <section className="timeline" aria-label="Three-month energy timeline">
        <button type="button" className="icon-button" onClick={()=>step(-1)} aria-label="Previous 15 minutes">‹</button>
        <button type="button" className="play-button" onClick={()=>setPlaying(p=>!p)} aria-label={playing?'Pause':'Play'}>{playing?'❚❚':'▶'}</button>
        <div className="timeline-main">
          <div className="timeline-header timeline-header-centered">
            <strong>{dateLabel} · {timeLabel}</strong>
            
          </div>
          <input type="range" min="0" max={TOTAL_FRAMES-1} step="1" value={frame}
            onChange={e=>{setPlaying(false);setFrame(Number(e.target.value))}} aria-label="15-minute interval"/>
        </div>
        <button type="button" className="icon-button" onClick={()=>step(1)} aria-label="Next 15 minutes">›</button>
      </section>
    </>}
    {mode==='energy'&&<div className="map-energy-legend">
      <strong>load anomaly</strong>
      <div className="map-ramp"/>
      <div className="map-axis"><span>typical</span><span>elevated</span><span>unusual</span><span>extreme</span></div>
      <small>&lt;0.5σ　≥0.5σ　≥1σ　≥1.5σ</small>
    </div>}
    {error&&<div className="error-banner">{error}</div>}
  </main>
}
export default App
