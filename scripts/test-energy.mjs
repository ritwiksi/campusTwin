// Uses the exact color and z-score functions copied from Temple Twin.
import assert from 'node:assert/strict'
import {getLoadZScore,getLoadAnomalyColor,getLoadAnomalyStatusColor} from '../src/config/energy.ts'
import {demandKW,grossAnnualDemandMwh,INTERVALS_PER_DAY} from '../src/config/demand.ts'

const profile=[0,1,2,3].map(x=>({energy_intensity_w_ft2:x}))
assert.equal(getLoadZScore(1.5,profile),0)
assert.ok(Math.abs(getLoadZScore(3,profile)-3/Math.sqrt(5))<1e-12)
assert.equal(getLoadZScore(12,[{energy_intensity_w_ft2:1},{energy_intensity_w_ft2:1}]),0)
assert.equal(getLoadAnomalyColor(0.49),'#22c55e')
assert.equal(getLoadAnomalyColor(0.5),'#eab308')
assert.equal(getLoadAnomalyColor(0.999),'#eab308')
assert.equal(getLoadAnomalyColor(1),'#f59e0b')
assert.equal(getLoadAnomalyColor(1.499),'#f59e0b')
assert.equal(getLoadAnomalyColor(1.5),'#ef4444')
assert.equal(getLoadAnomalyStatusColor(0.49),'#6fbd87')
assert.equal(getLoadAnomalyStatusColor(0.5),'#d2b25e')
assert.equal(getLoadAnomalyStatusColor(1),'#cf8a58')
assert.equal(getLoadAnomalyStatusColor(1.5),'#d56565')
// Tempo of playback is 15-minute intervals, and energy integrates to annual target.
for(const use of ['Housing','Research','Academic']){
  const building={use,electric_mwh:1200}
  let kwh=0
  for(let frame=0;frame<365*INTERVALS_PER_DAY;frame++)kwh+=demandKW(building,frame)*.25
  assert.ok(Math.abs(kwh-1200000)<.5, use+' annual profile energy mismatch: '+kwh)
}
assert.equal(grossAnnualDemandMwh({use:'Academic',electric_mwh:1200,electric_after_mwh:950,solar_mwh:250}),1200)
assert.equal(grossAnnualDemandMwh({use:'Research',electric_mwh:1200,electric_after_mwh:900,solar_mwh:0}),900)

// The original daily anomaly scale must produce multiple colors as time moves.
const frame=13*96+48 // Sep 14, 2018 12:00, the original Temple Twin start view
const palette=new Set()
for(const use of ['Housing','Research','Academic']){
  const building={use,electric_mwh:1200}
  const dayStart=Math.floor(frame/96)*96
  const baseline=Array.from({length:96},(_,i)=>({energy_intensity_w_ft2:demandKW(building,dayStart+i)*1000/200000}))
  const value=demandKW(building,frame)*1000/200000
  palette.add(getLoadAnomalyColor(getLoadZScore(value,baseline)))
}
assert.ok(palette.size>=2,'Campus should show varying anomaly colors at the default date')

console.log('Temple Twin colors, daily variation, annual energy integral, and solar separation verified')
