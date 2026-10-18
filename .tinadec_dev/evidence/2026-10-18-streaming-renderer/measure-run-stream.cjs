
const { DatabaseSync } = require('node:sqlite');
const h = new DatabaseSync('C:/git/agent/RouterAPI/.tinadec/data/tinadec.db', { readOnly: true });
const parse = (s) => new Date(s.replace(' ', 'T')).getTime();
const runs = h.prepare('select id, status, created_at, completed_at from runs order by created_at').all();
const out = [];
for (const r of runs) {
  const rows = h.prepare('select sequence, kind, created_at from run_stream where run_id=? order by sequence').all(r.id);
  const ack = rows.find(x=>x.kind==='ack');
  const started = rows.find(x=>x.kind==='answer.started');
  const deltas = rows.filter(x=>x.kind==='answer.delta');
  const delta = rows.find(x=>x.kind==='delta');
  const done = rows.find(x=>x.kind==='done');
  out.push({
    run_id: r.id,
    status: r.status,
    total_s: ack && done ? +((parse(done.created_at)-parse(ack.created_at))/1000).toFixed(2) : null,
    ack_to_answer_started_s: ack && started ? +((parse(started.created_at)-parse(ack.created_at))/1000).toFixed(2) : null,
    answer_started_to_first_delta_s: started && deltas[0] ? +((parse(deltas[0].created_at)-parse(started.created_at))/1000).toFixed(2) : null,
    text_window_s: deltas.length ? +((parse(deltas.at(-1).created_at)-parse(deltas[0].created_at))/1000).toFixed(2) : 0,
    last_delta_to_done_s: deltas.length && done ? +((parse(done.created_at)-parse(deltas.at(-1).created_at))/1000).toFixed(2) : null,
    answer_delta_count: deltas.length,
    chunk_gaps_ms: deltas.slice(1).map((d,i)=> parse(d.created_at)-parse(deltas[i].created_at)),
  });
}
console.log(JSON.stringify(out, null, 1));
h.close();
