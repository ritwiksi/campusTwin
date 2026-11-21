// Annual-scale calibration follows Temple Twin's approach: the displayed
// load shape is normalized so its 15-minute integral matches annual energy.
// Unlike Temple Twin, these SHAPES are analytic placeholders, not ComStock data.
export const START = Date.UTC(2018,8,1)
export const INTERVALS_PER_DAY = 96
export const DAYS = 91
export const TOTAL_FRAMES = DAYS * INTERVALS_PER_DAY
type ShapeKind = 'housing' | 'laboratory' | 'other'
export type EnergyBuilding = {use:string; electric_mwh:number}

function kind(use:string):ShapeKind {
  if (/housing|residence|dorm/i.test(use))return 'housing'
  if (/research|laboratory|science|engineering/i.test(use))return 'laboratory'
  return 'other'
}
function rawShape(k:ShapeKind,frame:number):number {
  const date=new Date(START+Math.floor(frame/96)*86400000)
  const hour=(frame%96)/4
  const weekend=date.getUTCDay()===0||date.getUTCDay()===6
  const occupancy=k==='housing'
    ? .88+.22*Math.cos((hour-21)*Math.PI/12)
    : k==='laboratory'
      ? .83+.27*Math.cos((hour-14)*Math.PI/12)
      : .70+.43*Math.cos((hour-14)*Math.PI/12)
  const weekdayFactor=weekend?(k==='housing'?1.02:k==='laboratory'?.92:.72):1.03
  const seasonalFactor=date.getUTCMonth()===8?1.08:date.getUTCMonth()===9?.94:1.02
  return Math.max(0,occupancy*weekdayFactor*seasonalFactor)
}
const annualMean=new Map<ShapeKind,number>()
function meanShape(k:ShapeKind):number {
  const cached=annualMean.get(k)
  if(cached!==undefined)return cached
  // One calendar year of 15-minute profiles, starting September 1, 2018.
  const count=365*INTERVALS_PER_DAY
  let total=0
  for(let i=0;i<count;i++)total+=rawShape(k,i)
  const mean=total/count
  annualMean.set(k,mean)
  return mean
}
export function demandKW(building:EnergyBuilding,frame:number,annualMwh=building.electric_mwh):number {
  const k=kind(building.use)
  return Math.max(0,annualMwh*1000/8760*rawShape(k,frame)/meanShape(k))
}

// PV displaces grid imports; it does not lower the building's gross demand.
export function grossAnnualDemandMwh(b:EnergyBuilding & {electric_after_mwh?:number;solar_mwh?:number}):number {
  if(b.electric_after_mwh===undefined)return b.electric_mwh
  return b.electric_after_mwh+(b.solar_mwh||0)
}
