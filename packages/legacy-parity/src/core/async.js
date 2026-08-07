import { raf } from './text.js';

export function idleFrame(){return new Promise(r=>{if(window.requestIdleCallback)window.requestIdleCallback(()=>r(),{timeout:90});else setTimeout(()=>r(),24);});}

export let _yT=0;
export function resetYield(){_yT=performance.now();}

/* Adaptive yield: hand control back to the browser whenever a tight loop has held
   the main thread for >~28ms, so huge datasets never trip the "page unresponsive"
   dialog. Reports progress at the same time so the bar advances smoothly. */
export async function maybeYield(report,frac,label){
  const now=performance.now();
  if(now-_yT>28){if(report)report(frac,label);await raf();_yT=performance.now();}
}
