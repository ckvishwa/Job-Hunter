// One self-contained page. All data is written with textContent / DOM nodes, never innerHTML.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SYSTEM://VISHVA job-hunter</title>
<style>
:root{--bg:#07090a;--panel:#0d1210;--line:#1f3a2c;--fg:#c9e8d4;--dim:#7fa08c;--acc:#39ff88;--warn:#ffcc4d;--bad:#ff5d6c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace}
header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;padding:14px 20px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:18px;color:var(--acc);letter-spacing:.06em}h1 span{color:var(--dim)}
#meta{color:var(--dim);font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:16px 20px}
section{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:12px 14px;min-width:0}
section.wide{grid-column:1/-1}
h2{margin:0 0 10px;font-size:13px;color:var(--acc);text-transform:uppercase;letter-spacing:.1em}h2::before{content:"> ";color:var(--dim)}
.row{display:flex;gap:10px;align-items:center;margin:4px 0}.row .k{flex:0 0 150px;color:var(--fg)}.row .v{flex:0 0 auto;min-width:34px;text-align:right;color:var(--acc)}
.bar{flex:1;height:8px;background:#122019;border-radius:2px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc)}
.nodata{color:var(--warn)}.dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #15261d;vertical-align:top}
th{color:var(--dim);font-weight:normal;position:sticky;top:0;background:var(--panel)}
.scroll{max-height:420px;overflow:auto}
input,select{background:#0a1410;color:var(--fg);border:1px solid var(--line);padding:5px 8px;font:inherit;border-radius:3px}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
a{color:#6ee7ff}a:hover{color:#fff}
.tag{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:0 5px;margin:0 3px 2px 0;font-size:11.5px;color:var(--warn)}
ul{margin:6px 0 0;padding-left:18px}
</style></head><body>
<header><h1>SYSTEM://VISHVA <span>/ job-hunter</span></h1><div id="meta">loading…</div></header>
<main>
<section><h2>Funnel by stage</h2><div id="funnel"></div></section>
<section><h2>Live agent activity</h2><div id="activity"></div></section>
<section><h2>Daily queue</h2><div id="queue"></div></section>
<section><h2>Board health</h2><div id="boards"></div></section>
<section><h2>Flag breakdown</h2><div id="flags"></div></section>
<section><h2>Stage data sources</h2><div id="emitters"></div></section>
<section class="wide"><h2>Jobs</h2>
<div class="filters"><input id="q" placeholder="filter company / title" aria-label="filter text"><select id="fState" aria-label="state"></select><select id="fTrack" aria-label="track"></select><select id="fFlag" aria-label="flag"></select></div>
<div class="scroll"><table><thead><tr><th>Company</th><th>Title</th><th>Track</th><th>State</th><th>Decision</th><th>ATS</th><th>Location</th><th>Flags</th><th>Official URL</th></tr></thead><tbody id="jobs"></tbody></table></div>
<div id="count" class="dim"></div></section>
</main>
<script>
"use strict";
var $=function(id){return document.getElementById(id)};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function nodata(parent,reason){var d=el("div","nodata","no data");parent.appendChild(d);if(reason)parent.appendChild(el("div","dim",reason))}
function bars(parent,items){var max=Math.max.apply(null,[1].concat(items.map(function(i){return i.count})));
 items.forEach(function(i){var r=el("div","row");r.appendChild(el("span","k",i.label));var b=el("span","bar");var f=document.createElement("i");f.style.width=(100*i.count/max)+"%";b.appendChild(f);r.appendChild(b);r.appendChild(el("span","v",String(i.count)));parent.appendChild(r)})}
var snap=null;
function renderFunnel(s){var n=$("funnel");clear(n);bars(n,s.funnel.map(function(f){return{label:f.stage,count:f.count}}))}
function renderActivity(s){var n=$("activity");clear(n);var a=s.activity;
 n.appendChild(el("div",a.active?"ok":"dim",a.active?"RUN ACTIVE":"no active run"));
 if(a.run)n.appendChild(el("div","dim","run "+a.run.runId+" ["+a.run.runType+"] started "+a.run.startedAt+(a.run.endedAt?" ended "+a.run.endedAt+" -> "+a.run.outcome:"")));
 if(a.current)n.appendChild(el("div","ok","stage: "+a.current.stage+(a.current.company?" / "+a.current.company:"")+(a.current.jobId?" / "+a.current.jobId:"")));
 n.appendChild(el("div","dim","last 20 events:"));
 if(a.events.status!=="ok")nodata(n,a.events.reason);
 else{var u=el("ul");a.events.items.forEach(function(e){var t=e.at.slice(11,19)+" "+e.kind+(e.stage?" "+e.stage:"")+(e.company?" / "+e.company:"")+(e.jobId?" / "+e.jobId:"")+(e.outcome?" -> "+e.outcome:"")+(e.errorCode?" ("+e.errorCode+")":"")+(e.durationMs!==null?" "+e.durationMs+"ms":"");u.appendChild(el("li",e.errorCode?"bad":"",t))});n.appendChild(u);
  if(a.events.skippedLines)n.appendChild(el("div","dim",a.events.skippedLines+" unreadable line(s) skipped"))}
 if(a.latestCheckpoint){var c=a.latestCheckpoint;n.appendChild(el("div","dim","latest checkpoint: "+c.company+" / "+c.title+" ["+c.outcome+"] "+c.updatedAt))}
 n.appendChild(el("div","dim","typed errors:"));
 if(!a.typedErrors.length)n.appendChild(el("div","ok","none recorded"));
 else{var e=el("ul");a.typedErrors.forEach(function(x){e.appendChild(el("li","bad",x.source+": "+(x.company?x.company+" / ":"")+x.stage+": "+x.errorCode))});n.appendChild(e)}}
function renderQueue(s){var n=$("queue");clear(n);var q=s.queue;n.appendChild(el("div","dim","target "+q.target.total+"/day: "+q.target.SECURITY+" SECURITY / "+q.target.QA+" QA"));
 nodata(n,q.reason);n.appendChild(el("div","dim","ledger rows by track (not today's queue): SECURITY "+q.byTrack.SECURITY+", QA "+q.byTrack.QA))}
function renderBoards(s){var n=$("boards");clear(n);var b=s.boards;
 n.appendChild(el("div","nodata","verify results: no data"));n.appendChild(el("div","dim",b.verifyResults.reason));
 if(b.status!=="ok"){nodata(n,b.reason);return}
 var t=el("table");var h=el("tr");["Company","ATS","Board","Ledger jobs"].forEach(function(x){h.appendChild(el("th","",x))});t.appendChild(h);
 b.companies.forEach(function(c){var r=el("tr");[c.company,c.ats,c.board,String(c.ledgerJobs)].forEach(function(x){r.appendChild(el("td","",x))});t.appendChild(r)});
 var w=el("div","scroll");w.appendChild(t);n.appendChild(w)}
function renderFlags(s){var n=$("flags");clear(n);if(!s.flags.length){n.appendChild(el("div","dim","no flags in ledger"));return}bars(n,s.flags.map(function(f){return{label:f.flag,count:f.count}}))}
function renderEmitters(s){var n=$("emitters");clear(n);var u=el("ul");s.stageEmitters.forEach(function(x){u.appendChild(el("li","",x.stage+": "+(x.emitsRunEvents?"emits run events":"no run events")+" - "+x.persists))});n.appendChild(u)}
function fillSelect(sel,label,values){var cur=sel.value;clear(sel);var o=el("option","",label);o.value="";sel.appendChild(o);values.forEach(function(v){var x=el("option","",v);x.value=v;sel.appendChild(x)});sel.value=values.indexOf(cur)>=0?cur:""}
function uniq(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i}).sort()}
function renderJobs(s){fillSelect($("fState"),"all states",uniq(s.jobs.map(function(j){return j.state})));fillSelect($("fTrack"),"all tracks",uniq(s.jobs.map(function(j){return j.track})));
 fillSelect($("fFlag"),"all flags",uniq([].concat.apply([],s.jobs.map(function(j){return j.flags}))));applyJobFilter()}
function applyJobFilter(){if(!snap)return;var q=$("q").value.toLowerCase(),st=$("fState").value,tr=$("fTrack").value,fl=$("fFlag").value;var body=$("jobs");clear(body);var shown=0;
 snap.jobs.forEach(function(j){if(st&&j.state!==st)return;if(tr&&j.track!==tr)return;if(fl&&j.flags.indexOf(fl)<0)return;if(q&&(j.company+" "+j.title).toLowerCase().indexOf(q)<0)return;shown++;
  var r=el("tr");[j.company,j.title,j.track,j.state,j.decision,j.ats,j.location].forEach(function(x){r.appendChild(el("td","",x))});
  var f=el("td");j.flags.forEach(function(x){f.appendChild(el("span","tag",x))});r.appendChild(f);
  var u=el("td");if(/^https:\\/\\//i.test(j.officialUrl)){var a=el("a","",j.officialUrl);a.href=j.officialUrl;a.target="_blank";a.rel="noopener noreferrer";u.appendChild(a)}else u.appendChild(el("span","dim","-"));r.appendChild(u);body.appendChild(r)});
 $("count").textContent=shown+" of "+snap.jobs.length+" jobs"}
var timer=null;
function render(s){snap=s;$("meta").textContent="read-only - 127.0.0.1 - updated "+s.generatedAt+(s.problems.length?" - "+s.problems.length+" unreadable files":"");
 renderFunnel(s);renderActivity(s);renderQueue(s);renderBoards(s);renderFlags(s);renderEmitters(s);renderJobs(s)}
function poll(){fetch("/api/snapshot",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){render(s);schedule(s.activity.active?3000:20000)}).catch(function(){$("meta").textContent="snapshot failed; retrying";schedule(10000)})}
function schedule(ms){clearTimeout(timer);timer=setTimeout(poll,ms)}
["q","fState","fTrack","fFlag"].forEach(function(id){$(id).addEventListener("input",applyJobFilter)});
poll();
</script></body></html>`;
