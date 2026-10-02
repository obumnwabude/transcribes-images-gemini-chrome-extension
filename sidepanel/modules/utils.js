export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function getBasename(filename) {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.substring(0, idx) : filename;
}

export function computeBackoff(step, base, cap) {
  const exp = Math.min(cap, base * Math.pow(2, step - 1));
  const jitter = Math.random() * Math.min(1000, exp * 0.2);
  return Math.round(exp + jitter);
}

export function truncateForPreview(text, max = 400) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}
