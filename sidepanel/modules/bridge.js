import { BRIDGE_URL } from './constants.js';
import { bridgeBadge, bridgeStatusText } from './dom.js';

export { BRIDGE_URL };

export async function checkBridgeHealth() {
  bridgeStatusText.textContent = 'Connecting...';
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.status === 'ok') {
      bridgeBadge.className = 'badge badge-online';
      bridgeStatusText.textContent = 'Bridge Online';
      return true;
    }
    bridgeBadge.className = 'badge badge-offline';
    bridgeStatusText.textContent = 'Bridge Error';
    return false;
  } catch (err) {
    bridgeBadge.className = 'badge badge-offline';
    bridgeStatusText.textContent = 'Bridge Offline';
    return false;
  }
}
