/**
 * URL 状态：只保存允许的场景与配置，非法值忽略。
 * 不把事件轨迹写进 URL。
 */
export const URL_KEYS = ['scenario', 'gen', 'width', 'mode'];

export function parseState(hash, { scenarios, widths }) {
  const out = {};
  if (!hash) return out;
  let params;
  try {
    params = new URLSearchParams(String(hash).replace(/^#/, ''));
  } catch {
    return out;
  }
  const scenario = params.get('scenario');
  if (scenario && scenarios && scenarios[scenario]) out.scenario = scenario;

  const gen = Number(params.get('gen'));
  if ([1, 2, 3, 4, 5, 6].includes(gen)) out.gen = gen;

  const width = Number(params.get('width'));
  if (Array.isArray(widths) && widths.includes(width)) out.width = width;

  const mode = params.get('mode');
  if (['auto', 'nonflit', 'flit'].includes(mode)) out.mode = mode;

  return out;
}

export function formatState({ scenario, gen, width, mode }) {
  const params = new URLSearchParams();
  params.set('scenario', String(scenario));
  params.set('gen', String(gen));
  params.set('width', String(width));
  params.set('mode', String(mode));
  return `#${params.toString()}`;
}
