/** Every asset resolves relative to this application's installation directory. */
export const appBaseURL = new URL('../', import.meta.url);
export function assetURL(path) { return new URL(String(path).replace(/^\/+/, ''), appBaseURL).href; }
export function appURL(fragment = '') { const url = new URL(appBaseURL); url.hash = fragment; return url.href; }
export const isLocalDemo = globalThis.VELSIGN_CONFIG?.mode === 'local-demo';
