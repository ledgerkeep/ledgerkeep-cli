import type { TtlReading } from "../rpc/ttl.js";

/** Why a contract does or does not need maintenance now. */
export interface MaintenanceDecision {
  needed: boolean;
  reason: string;
  lowKeys: string[];
  archivedKeys: string[];
}

/**
 * The threshold to judge a contract by.
 *
 * A registered threshold of zero means the contract published no useful value,
 * so the operator's `LK_THRESHOLD` stands in. Anything positive wins, because the
 * contract knows its own needs better than a global default does.
 */
export function effectiveThreshold(registered: number, fallback: number): number {
  return registered > 0 ? registered : fallback;
}

/**
 * Decide whether a contract needs maintenance.
 *
 * Needed when any observed key is below threshold or already archived. Pure, so
 * the daemon's decision is testable without a network.
 */
export function decideMaintenance(readings: TtlReading[], threshold: number): MaintenanceDecision {
  if (readings.length === 0) {
    return { needed: false, reason: "no keys observed", lowKeys: [], archivedKeys: [] };
  }

  const lowKeys: string[] = [];
  const archivedKeys: string[] = [];

  for (const reading of readings) {
    if (reading.remaining <= 0) {
      archivedKeys.push(reading.description);
    } else if (reading.remaining < threshold) {
      lowKeys.push(reading.description);
    }
  }

  const needed = lowKeys.length > 0 || archivedKeys.length > 0;
  const reason = needed
    ? `${lowKeys.length} low, ${archivedKeys.length} archived, threshold ${threshold}`
    : `all ${readings.length} keys above threshold ${threshold}`;

  return { needed, reason, lowKeys, archivedKeys };
}
