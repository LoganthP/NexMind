// jsdom has no layout/WebGL APIs; provide the few the UI touches.
class RO { observe() {} unobserve() {} disconnect() {} }
;(globalThis as any).ResizeObserver = RO
;(globalThis as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })
Element.prototype.scrollTo = () => {}
;(window as any).scrollTo = () => {}
// Node's built-in WebSocket dispatches events jsdom cannot accept; use the `ws` client in tests instead.
import WS from 'ws'
;(globalThis as any).WebSocket = WS
import './setup-timeout'
