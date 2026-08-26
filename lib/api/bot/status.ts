import { NextApiRequest, NextApiResponse } from 'next';
import { getConfig } from '../../engine';

let isTicking = false;
let lastTickTime: number | null = null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const cfg = await getConfig();
    const now = Date.now();
    const timeSinceLastTick = lastTickTime ? ((now - lastTickTime) / 1000) : null;
    
    res.status(200).json({
      status: cfg.status || 'unknown',
      isTicking,
      lastTickTime: lastTickTime ? new Date(lastTickTime).toISOString() : null,
      secondsSinceLastTick: timeSinceLastTick,
      isStuck: isTicking && timeSinceLastTick !== null && timeSinceLastTick > 60,
      symbolsToMonitor: (cfg as any).symbolsToMonitor || []
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
}

// Export for global state
export function setTickState(ticking: boolean) {
  isTicking = ticking;
  if (ticking) {
    lastTickTime = Date.now();
  }
}
