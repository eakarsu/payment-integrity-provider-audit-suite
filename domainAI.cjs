'use strict';
const https = require('node:https');
const FEATURES = [
  {
    "id": "claim-selection-risk",
    "label": "Claim selection risk review",
    "table": "claimSelection",
    "description": "Prioritise claim-selection records by risk score for audit sampling."
  },
  {
    "id": "overpayment-recovery-review",
    "label": "Overpayment recovery review",
    "table": "overpayments",
    "description": "Summarise overpayment records by recovery status, blocked and overdue items."
  },
  {
    "id": "provider-audit-readiness",
    "label": "Provider audit readiness",
    "table": "providerAudit",
    "description": "Check provider-audit records for documentation or finding follow-up."
  }
];
const HEALTHCARE = true;
function today(){return new Date().toISOString().slice(0,10);}
function analyse(feature, data){
  const rows = Array.isArray(data[feature.table]) ? data[feature.table] : [];
  const byStatus={}; const byPriority={};
  for(const r of rows){ byStatus[r.status||'Unknown']=(byStatus[r.status||'Unknown']||0)+1; byPriority[r.priority||'Unknown']=(byPriority[r.priority||'Unknown']||0)+1; }
  const blocked=rows.filter(r=>r.status==='Blocked').length;
  const overdue=rows.filter(r=>r.dueDate && r.dueDate<today() && r.status!=='Complete').length;
  const highPriority=rows.filter(r=>['High','Escalate'].includes(r.priority)).length;
  const open=rows.filter(r=>r.status!=='Complete').length;
  const avgRisk=rows.length?Math.round(rows.reduce((s,r)=>s+Number(r.riskScore||0),0)/rows.length):0;
  const topRecords=[...rows].sort((a,b)=>Number(b.riskScore||0)-Number(a.riskScore||0)).slice(0,5).map(r=>({id:r.id,item:r.item,status:r.status,priority:r.priority,riskScore:Number(r.riskScore||0),dueDate:r.dueDate,owner:r.owner}));
  const findings=[];
  findings.push({label:'Records reviewed',value:rows.length});
  findings.push({label:'Open records',value:open});
  findings.push({label:'Blocked records',value:blocked});
  findings.push({label:'Overdue records',value:overdue});
  findings.push({label:'High or escalated priority',value:highPriority});
  findings.push({label:'Average risk score',value:avgRisk});
  const recommendations=[];
  if(blocked>0) recommendations.push('Review blocked records first and clear the blocking reason with the owner.');
  if(overdue>0) recommendations.push('Follow up overdue records before new routine work.');
  if(highPriority>0) recommendations.push('Escalate high-priority records for human review.');
  if(!recommendations.length) recommendations.push('No blocked, overdue or high-priority records found; maintain current cadence.');
  return {feature:feature.id,label:feature.label,table:feature.table,aiGenerated:false,source:'deterministic',mode:'deterministic-fallback',summary:`${feature.label}: reviewed ${rows.length} record(s) in ${feature.table}; ${blocked} blocked, ${overdue} overdue, ${highPriority} high/escalated, average risk ${avgRisk}.`,counts:{total:rows.length,open,blocked,overdue,highPriority,avgRisk,byStatus,byPriority},findings,topRecords,recommendations,disclaimer:HEALTHCARE?'Operational navigation/review support only. No diagnosis or treatment recommendation is made; a qualified human must decide.':'Operational support only. A qualified human reviewer must decide before any regulated, financial or safety action.'};
}
function providerConfig(env){
  if(env.OPENROUTER_API_KEY && !/changeme|your[_-]?key|placeholder/i.test(env.OPENROUTER_API_KEY)) return {source:'openrouter',hostname:'openrouter.ai',path:'/api/v1/chat/completions',key:env.OPENROUTER_API_KEY,model:env.OPENROUTER_MODEL||'openai/gpt-4o-mini'};
  if(env.OPENAI_API_KEY && !/changeme|your[_-]?key|placeholder/i.test(env.OPENAI_API_KEY)) return {source:'openai',hostname:'api.openai.com',path:'/v1/chat/completions',key:env.OPENAI_API_KEY,model:env.OPENAI_MODEL||'gpt-4o-mini'};
  return null;
}
function callProvider(cfg, feature, deterministic, env){
  const body=JSON.stringify({model:cfg.model,messages:[{role:'system',content:'Return only JSON with keys summary (string), findings (array of {label,value}), recommendations (array of strings). Base it only on the supplied records. Do not invent facts. '+(HEALTHCARE?'Make no diagnosis or treatment claims.':'')},{role:'user',content:JSON.stringify({feature:feature.label,deterministic})}]});
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:cfg.hostname,path:cfg.path,method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.key,'Content-Length':Buffer.byteLength(body)}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{try{if(res.statusCode<200||res.statusCode>=300) throw new Error('provider '+res.statusCode);const parsed=JSON.parse(t);const content=parsed.choices?.[0]?.message?.content;const obj=JSON.parse(String(content).replace(/^```json\s*|\s*```$/g,''));resolve(obj);}catch(e){reject(e);}});});
    req.on('error',reject); req.setTimeout(30000,()=>{req.destroy(new Error('provider timeout'));}); req.write(body); req.end();
  });
}
async function run(featureId, data, env=process.env){
  const feature=FEATURES.find(f=>f.id===featureId);
  if(!feature) throw Object.assign(new Error('Unknown AI feature'),{status:404});
  const deterministic=analyse(feature,data);
  const cfg=providerConfig(env);
  if(!cfg) return deterministic;
  try{
    const obj=await callProvider(cfg,feature,deterministic,env);
    return {...deterministic,...obj,feature:feature.id,label:feature.label,table:feature.table,aiGenerated:true,source:cfg.source,mode:'provider',model:cfg.model,counts:deterministic.counts,topRecords:deterministic.topRecords,disclaimer:deterministic.disclaimer};
  }catch(e){ return {...deterministic,providerError:'Provider call failed; deterministic fallback shown.'}; }
}
module.exports={FEATURES,analyse,run,providerConfig};
