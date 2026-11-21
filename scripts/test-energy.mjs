// Uses the exact color and z-score functions copied from Temple Twin.
import assert from 'node:assert/strict'
import {getLoadZScore,getLoadAnomalyColor,getLoadAnomalyStatusColor} from '../src/config/energy.ts'

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
console.log('Temple Twin z-score and color thresholds verified')
