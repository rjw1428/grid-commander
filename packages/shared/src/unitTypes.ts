import { UnitTypeDefSchema, type UnitTypeDef } from "./domain.js";
import unitTypesJson from "./unit-types.json" with { type: "json" };

/** Shipped unit types, validated once at module load. */
export const UNIT_TYPES: readonly UnitTypeDef[] = unitTypesJson.map((t) =>
  UnitTypeDefSchema.parse(t),
);

export const UNIT_TYPE_BY_ID: ReadonlyMap<string, UnitTypeDef> = new Map(
  UNIT_TYPES.map((t) => [t.id, t]),
);

export function getUnitType(id: string): UnitTypeDef {
  const t = UNIT_TYPE_BY_ID.get(id);
  if (!t) throw new Error(`unknown unit type: ${id}`);
  return t;
}
