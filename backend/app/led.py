"""LED electricity scenario matching Temple Twin's ASHRAE reference/target LPDs.

Until ComStock lighting end-use profiles are available, baseline annual lighting is
estimated from reference lighting power density and equivalent use hours.
No Rutgers fixture inventory or measured lighting end-use is claimed.
"""
REFERENCE_LPD = {
    "school_university": 1.20, "office": 1.00, "hotel": 1.00,
    "warehouse": 0.80, "retail": 1.50, "parking_garage": 0.30,
    "sports_arena": 1.10,
}
TARGET_LPD = {
    "school_university": 0.70, "office": 0.62, "hotel": 0.53,
    "warehouse": 0.45, "retail": 0.78, "parking_garage": 0.17,
    "sports_arena": 0.73,
}
# Placeholder annual equivalent full-load lighting hours, explicitly assumed.
EQUIVALENT_HOURS = {
    "school_university": 2300, "office": 2500, "hotel": 2800,
    "warehouse": 2200, "retail": 2900, "parking_garage": 4200,
    "sports_arena": 2100,
}

def category(use: str) -> str:
    name = use.strip().lower()
    if name in {"residence", "housing"}:
        return "hotel"
    if name in {"office", "administration"}:
        return "office"
    if name == "athletics":
        return "sports_arena"
    if name in {"student life", "student center", "dining"}:
        return "school_university"
    return "school_university"

def assumptions(use: str, floor_area_ft2: float, annual_electric_mwh: float) -> dict:
    if floor_area_ft2 <= 0 or annual_electric_mwh < 0:
        raise ValueError("Invalid building area or annual electricity")
    kind = category(use)
    original = REFERENCE_LPD[kind]
    target = TARGET_LPD[kind]
    reference_mwh = floor_area_ft2 * original * EQUIVALENT_HOURS[kind] / 1e6
    lighting_mwh = min(annual_electric_mwh, reference_mwh)
    reduction = max(0.0, min(1.0, 1.0 - target / original))
    return {
        "led_category": kind,
        "led_reference_lpd_w_ft2": original,
        "led_target_lpd_w_ft2": target,
        "led_lighting_baseline_mwh": lighting_mwh,
        "led_reduction_fraction": reduction,
    }
