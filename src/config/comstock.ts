/** Cached NREL Middlesex County ComStock quarter-hour end-use factors.
 * Each factor is kW per building annual kWh, calibrated against the building's
 * estimated annual electricity. Solar affects net grid imports, not demand.
 */
export type ComstockDataset = {
  dataset: string
  county: string
  county_gisjoin: string
  period_start: string
  period_end: string
  interval_minutes: number
  component_order: string[]
  types: Record<string, {
    source_url: string
    annual_shares: number[]
    factors: number[][]
  }>
}

export type ProfileBuilding = {
  comstock_type: string
  electric_mwh: number
  led?: boolean
  hvac?: boolean
  led_reduction_fraction?: number
  hvac_reduction_fraction?: number
}
export type EndUses = { hvac: number; lighting: number; process: number; other: number; total: number }

export function componentsKW(data:ComstockDataset,b:ProfileBuilding,frame:number):EndUses {
  const type=data.types[b.comstock_type]
  if(!type)throw new Error('ComStock archetype unavailable: '+b.comstock_type)
  const row=type.factors[frame]
  if(!row || row.length!==4)throw new Error('ComStock interval unavailable: '+frame)
  const scale=b.electric_mwh*1000
  const hvac=row[0]*scale*(b.hvac ? 1-(b.hvac_reduction_fraction||0) : 1)
  const lighting=row[1]*scale*(b.led ? 1-(b.led_reduction_fraction||0) : 1)
  const process=row[2]*scale
  const other=row[3]*scale
  return {hvac,lighting,process,other,total:hvac+lighting+process+other}
}
