import { z } from "zod";
import type { ReviewItem } from "./llm-workflows.js";

const decisionSchema = z.object({ version: z.literal(1), batchId: z.string(), decisions: z.array(z.object({ index: z.number().int().nonnegative(), value: z.enum(["relevant", "irrelevant", "adjacent", "unsure"]), reviewed: z.literal(true), independent: z.boolean() }).strict()).min(1) }).strict();

export function validateDecisions(raw: unknown, batchId: string, items: readonly ReviewItem[]) {
  const result = decisionSchema.parse(raw);
  if (result.batchId !== batchId) throw new Error("Decisions belong to a different review batch.");
  const seen = new Set<number>();
  for (const d of result.decisions) {
    const item = items[d.index];
    if (!item || seen.has(d.index)) throw new Error("Unknown or duplicate review item.");
    seen.add(d.index);
    if (item.blind && !d.independent) throw new Error("Evaluation requires independent full-description verification.");
  }
  return result.decisions;
}

/** A proposal may be bulk-applied only if both passes agreed AND each pass quoted evidence from a complete (untruncated) description. */
const proposalOf = (it: ReviewItem): string | null => {
  const c = it.state?.consensus;
  if (c?.status !== "AGREED") return null;
  const passes = [it.state?.A, it.state?.B];
  return passes.every((p) => p && p.evidence.length > 0 && !p.jdTruncated) ? c.relevance : null;
};

/** Offline page: no remote scripts, no network calls, no labels saved until a human imports their decisions. */
export function renderReviewBatch(batchId: string, items: readonly ReviewItem[]): string {
  const data = items.map((it, index) => ({ index, title: it.posting.title, company: it.posting.company, description: it.posting.description, role: it.roleSlug, blind: it.blind,
    ...(it.blind ? {} : { proposal: proposalOf(it),
      passes: [it.state?.A, it.state?.B].filter(Boolean).map((p) => ({ pass: p!.pass, relevance: p!.relevance, reasoning: p!.reasoning, evidence: p!.evidence })) }),
  }));
  const json = JSON.stringify({ batchId, items: data }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Job relevance review</title>
<style>body{font:16px system-ui;max-width:1050px;margin:32px auto;padding:0 20px;background:#f5f7fb;color:#17243a}article{background:white;padding:24px;margin:18px 0;border:1px solid #ccd4df;border-radius:12px}pre{white-space:pre-wrap;font:inherit;line-height:1.5}button,select{font:inherit;padding:10px;margin:8px}header{position:sticky;top:0;background:#f5f7fb;padding:12px;border-bottom:1px solid #ccd4df}.proposal{border-left:4px solid #507caf;padding:12px}label{display:block;margin:12px 0}</style>
<header><h1>Review job relevance</h1><p>Read the complete description. Relevant means the daily work is this role; adjacent means related work; unsure preserves uncertainty. Nothing saves automatically.</p><button id="approve">Use proposals for checked training items</button><button id="download">Download reviewed decisions</button><span id="status" role="status"></span></header><main id="items"></main>
<script>const batch=${json};
const controls=[];
function el(tag,text,parent){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n;}
for(const it of batch.items){const card=el('article',undefined,document.getElementById('items'));el('h2',it.company+' — '+it.title,card);el('h3','Target role: '+it.role+(it.blind?' · Independent evaluation':' · Training review'),card);el('pre',it.description,card);
if(!it.blind){const p=el('div',undefined,card);p.className='proposal';for(const pass of it.passes||[]){el('p','Pass '+pass.pass+': '+pass.relevance+' — '+pass.reasoning,p);for(const q of pass.evidence||[])el('blockquote',q,p);}}
const label=el('label',undefined,card),checked=el('input',undefined,label);checked.type='checkbox';label.append(document.createTextNode(it.blind?' I independently reviewed the complete JD without AI-suggested answers.':' I reviewed this description and its supporting evidence.'));
const select=el('select',undefined,card);select.setAttribute('aria-label','Decision for '+it.title);for(const value of ['', 'relevant','irrelevant','adjacent','unsure']){const o=el('option',value||'Choose a label',select);o.value=value;}controls.push({it,checked,select});}
document.getElementById('approve').onclick=()=>{for(const c of controls)if(!c.it.blind&&c.checked.checked&&c.it.proposal)c.select.value=c.it.proposal;};
document.getElementById('download').onclick=()=>{const decisions=controls.filter(c=>c.checked.checked&&c.select.value).map(c=>({index:c.it.index,value:c.select.value,reviewed:true,independent:c.it.blind}));if(!decisions.length){document.getElementById('status').textContent='Review and label at least one item.';return;}const blob=new Blob([JSON.stringify({version:1,batchId:batch.batchId,decisions},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=batch.batchId+'-decisions.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);document.getElementById('status').textContent=decisions.length+' decisions downloaded; import them to save.';};
</script></html>`;
}
