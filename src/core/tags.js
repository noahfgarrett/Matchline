import { clean } from './text.js';
import { ruleEngine } from '../rules/provider.js';

// cleanTagRaw: unicode normalisation and separator cleanup only -- genuinely
// universal, no site convention.
// cleanTag: the active profile's complete identity, including Tag Anatomy.
export const cleanTagRaw=v=>clean(v).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[\u2010-\u2015\u2212]/g,'-').replace(/\s*-\s*/g,'-');
export const cleanTag=v=>ruleEngine().resolve(cleanTagRaw(v)).identity;

/* A Relate rule can compose a parent that ends in literal text the profile
   deliberately spelled with spaces, e.g. "<Building> - RACK". cleanTagRaw
   collapses ' - ' into '-', which would rewrite that parent into a tag the
   profile never asked for, so a trailing literal of that kind is preserved
   verbatim and only the part before it is normalised.

   The list is read from the active profile's own rules
   (engine.registerLiteralSuffixes), never named here -- which is what lets this
   file stay free of site vocabulary. */
const suffixMatcher=literal=>new RegExp('^(.*?)'+literal.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+')+'$','i');
export function cleanRegisterTag(value){
  const raw=clean(value);
  for(const literal of ruleEngine().registerLiteralSuffixes()){
    const hit=raw.match(suffixMatcher(literal));
    if(hit)return cleanTag(hit[1])+literal;
  }
  return cleanTag(raw);
}

/* separator-aware fuzzy matching: "ABC-1" vs "ABC_1" reads as 100% */
export const normSep=s=>clean(s).toLowerCase().replace(/[\s\-_\/.]+/g,'');
export function levDist(a,b){const m=a.length,n=b.length;if(!m)return n;if(!n)return m;let prev=[...Array(n+1).keys()],cur=new Array(n+1);for(let i=1;i<=m;i++){cur[0]=i;for(let j=1;j<=n;j++){const c=a[i-1]===b[j-1]?0:1;cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+c);}[prev,cur]=[cur,prev];}return prev[n];}
export function simPct(a,b){const A=normSep(a),B=normSep(b);if(!A&&!B)return 100;const ml=Math.max(A.length,B.length)||1;return Math.round((1-levDist(A,B)/ml)*100);}
