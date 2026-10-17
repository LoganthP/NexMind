const fs = require('fs');
const path = require('path');
const file = path.join(process.cwd(), 'src/workspace/actions.ts');
let content = fs.readFileSync(file, 'utf8');

const target1 = export function setMode(mode: 'explore' | 'impact' | 'trace' | 'flow') {
  let finalMode = mode
  if (get().mode === mode && mode !== 'explore') {
    finalMode = 'explore'
  }
  eng.current?.cancelPath()
  patch({ mode: finalMode, impact: null, trace: null, traceFrom: null, flowPlaying: false })
  if (finalMode !== 'flow') { eng.current?.setFocus(null); patch({ focus: null, flowProc: null, flowStep: -1 }) }
  else { patch({ panel: 'flows', railOpen: true }) }
}

export function setView(view: 'graph' | 'list' | 'split' | 'mindmap' | 'analytics') {
  patch({ view })
};

content = content.replace(/export function setMode[\s\S]*?\} \/\*[\s\S]*?\n\}/, target1);
fs.writeFileSync(file, content);
