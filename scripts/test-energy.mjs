// Temple Twin z-score colors + real cached Middlesex ComStock end-use profile tests.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {getLoadZScore,getLoadAnomalyColor,getLoadAnomalyStatusColor} from '../src/config/energy.ts'
import {componentsKW} from '../src/config/comstock.ts'

const profile=[0,1,2,3].map(x=>({energy_intensity_w_ft2:x}))
assert.equal(getLoadZScore(1.5,profile),0)
assert.ok(Math.abs(getLoadZScore(3,profile)-3/Math.sqrt(5))<1e-12)
assert.equal(getLoadZScore(12,[{energy_intensity_w_ft2:1},{energy_intensity_w_ft2:1}]),0)
for(const [z,color] of [[.49,'#22c55e'],[.5,'#eab308'],[1,'#f59e0b'],[1.5,'#ef4444']]){
  assert.equal(getLoadAnomalyColor(z),color)
}
for(const [z,color] of [[.49,'#6fbd87'],[.5,'#d2b25e'],[1,'#cf8a58'],[1.5,'#d56565']]){
  assert.equal(getLoadAnomalyStatusColor(z),color)
}

const dataset=JSON.parse(gunzipSync(readFileSync(new URL('../data/comstock/middlesex_amy2018.json.gz',import.meta.url))))
assert.equal(dataset.county_gisjoin,'g3400230')
assert.equal(dataset.dataset,'2021/comstock_amy2018_release_1')
assert.equal(dataset.interval_minutes,15)
for(const kind of Object.keys(dataset.types)){
  const type=dataset.types[kind]
  assert.equal(type.factors.length,8736)
  assert.ok(Math.abs(type.annual_shares.reduce((a,b)=>a+b,0)-1)<1e-7)
  const baseline={electric_mwh:1200,comstock_type:kind}
  const first=componentsKW(dataset,baseline,48)
  assert.ok(first.total>0)
  assert.ok(Math.abs(first.total-first.hvac-first.lighting-first.process-first.other)<1e-6)
  const retro=componentsKW(dataset,{...baseline,led:true,hvac:true,led_reduction_fraction:.4,hvac_reduction_fraction:.25},48)
  assert.ok(Math.abs(retro.hvac-first.hvac*.75)<1e-6)
  assert.ok(Math.abs(retro.lighting-first.lighting*.6)<1e-6)
  assert.ok(Math.abs(retro.process-first.process)<1e-6)
  assert.ok(Math.abs(retro.other-first.other)<1e-6)
  // The cached AMY2018 load shapes must vary over a day and produce real anomalies.
  const day=Array.from({length:96},(_,i)=>({energy_intensity_w_ft2:componentsKW(dataset,baseline,i).total}))
  const palette=new Set(day.map((_,i)=>getLoadAnomalyColor(getLoadZScore(day[i].energy_intensity_w_ft2,day))))
  assert.ok(palette.size>=2,kind+' produced a flat daily anomaly profile')
}
console.log('Temple Twin color boundaries + Middlesex ComStock quarter-hour end uses verified')
