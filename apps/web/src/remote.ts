const API = (import.meta.env as any).VITE_API_BASE as string;
const TOKEN = localStorage.getItem('2624b18afd19af0e7cd0ade6f0a39e8224ebd597') || ''; // положи ACCESS_TOKEN сюда руками 1 раз

function hdr() { return { 'content-type':'application/json', 'authorization': `Bearer ${TOKEN}` }; }

export async function listBots() {
  const r = await fetch(`${API}/bots`, { headers: hdr() });
  return await r.json();
}
export async function createBot(p: { name?:string; secretB64?:string; mint:string; strategy?:string; speedMs?:number; budgetSol?:number; slippageBps?:number; twap?:{slices:number;gapMs:number}|null }) {
  const r = await fetch(`${API}/bots`, { method:'POST', headers: hdr(), body: JSON.stringify(p) });
  return await r.json();
}
export async function startBot(id: string) {
  const r = await fetch(`${API}/bots/${id}/start`, { method:'POST', headers: hdr() });
  return await r.json();
}
export async function stopBot(id: string) {
  const r = await fetch(`${API}/bots/${id}/stop`, { method:'POST', headers: hdr() });
  return await r.json();
}
export async function delBot(id: string) {
  const r = await fetch(`${API}/bots/${id}`, { method:'DELETE', headers: hdr() });
  return await r.json();
}
