// Builds a probe page from the REAL rules in UieColumn.vue: the <style scoped> block is
// copied verbatim (scoped attribute selectors are stripped) and the DOM mirrors the new
// structure — clip wrapper inside, drag handle outside it. No hand-copied CSS.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const harness = import.meta.dirname
const source = readFileSync(join(harness, '../../../apps/TinadecUI/src/components/UieColumn.vue'), 'utf8')
const style = source.slice(source.indexOf('<style scoped>') + '<style scoped>'.length, source.lastIndexOf('</style>'))

const panel = (id, left, extra = '') => `
  <div id="${id}" class="uie-column" style="left:${left}px;top:40px;width:260px;height:260px;${extra}">
    <div class="uie-column-clip">
      <div class="uie-stack" style="left:0;top:0;width:260px;height:260px;background:#22252c;border:1px solid #3a3f4b;border-radius:12px"></div>
    </div>
    <div class="uie-column-resizer uie-column-resizer-right"></div>
  </div>
  <div class="uie-column" style="left:${left + 268}px;top:40px;width:100px;height:260px">
    <div class="uie-column-clip"><div class="uie-stack" style="left:0;top:0;width:100px;height:260px;background:#1c1f25;border:1px solid #303540;border-radius:12px"></div></div>
  </div>`

writeFileSync(join(harness, 'generated.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>resizer probe (real rules)</title>
<style>
  /* Only the tokens the copied rules consume; the real app supplies them via styles.css. */
  :root { --accent-primary: #6ea8fe; }
  html, body { height: 100%; margin: 0; background: #16181d; color: #cfd4dd; }
  body { position: relative; }
  .uie-stack { position: absolute; }
${style}
</style></head>
<body>
${panel('a', 40)}
${panel('b', 420)}
</body></html>
`)
console.log('generated.html written with', style.split('\n').length, 'lines of real CSS')
