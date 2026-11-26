const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const mini = path.join(root, 'miniprogram')
const sources = JSON.parse(fs.readFileSync(path.join(mini, 'locales/zh-ui.json'), 'utf8'))
const catalog = {}
function add(source, values) {
  if (values.length !== 6 || values.some(value => !value)) throw new Error('Incomplete translation: ' + source)
  catalog[source] = values
}
const rows = fs.readFileSync(path.join(mini, 'locales/ui-translations.tsv'), 'utf8').trimEnd().split(/\r?\n/)
for (const row of rows) { const [id, ...values] = row.split('|'); add(sources[Number(id)], values) }
for (const source of sources) if (!catalog[source]) throw new Error('Missing UI translation: ' + source)
for (const row of ['messages.tsv', 'adjustments.tsv', 'reports.tsv', 'private-unlimited.tsv', 'coach-profile.tsv', 'store-gallery.tsv', 'store-details.tsv', 'booking-records.tsv', 'booking-safety.tsv', 'points-mall.tsv'].flatMap(file => fs.readFileSync(path.join(mini, 'locales', file), 'utf8').trimEnd().split(/\r?\n/))) {
  if (!row) continue
  const [source, ...values] = row.split('|'); add(source, values)
}
for (const [source, [template, params = []]] of Object.entries(require('../miniprogram/locales/feedback-aliases'))) {
  if (catalog[source]) continue
  if (!catalog[template]) throw new Error('Missing alias template: ' + template)
  add(source, catalog[template].map((value, language) => {
    for (let i = 0; i < params.length; i++) {
      if (!catalog[params[i]]) throw new Error('Missing alias argument: ' + params[i])
      value = value.replaceAll('{' + i + '}', catalog[params[i]][language])
    }
    return value
  }))
}
const keys = Object.keys(catalog)
const patterns = Object.keys(catalog).filter(key => /\{\d+\}/.test(key)).map(key => ({ key:keys.indexOf(key), parts: key.split(/\{\d+\}/), slots: [...key.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1])) }))
const fragments = Object.keys(catalog).filter(key => key.length >= 2 && !/\{\d+\}/.test(key)).sort((a, b) => b.length - a.length)
// 只为重复长译文建立共享词表，避免短词索引反而增大包体。
const rowsForPool=keys.map(k=>catalog[k]),counts=new Map()
for(const word of rowsForPool.flat()) counts.set(word,(counts.get(word)||0)+1)
const words=[...counts].filter(([w,n])=>n>1&&(n-1)*Buffer.byteLength(JSON.stringify(w))>n*5+Buffer.byteLength(JSON.stringify(w))*0.1).map(([w])=>w)
const wordIndex=new Map(words.map((w,i)=>[w,i]))
const compactRows=rowsForPool.map(row=>row.map(word=>wordIndex.has(word)?wordIndex.get(word):word))
let body = `var keys = ${JSON.stringify(keys)};
var words = ${JSON.stringify(words)};
var values = ${JSON.stringify(compactRows)};
var catalog = {};
for(var c=0;c<keys.length;c++) { var row=[]; for(var v=0;v<values[c].length;v++) row.push(typeof values[c][v] === 'number' ? words[values[c][v]] : values[c][v]); catalog[keys[c]]=row; }
var indexes = { en: 0, fr: 1, th: 2, de: 3, ja: 4, hi: 5 };
var patterns = ${JSON.stringify(patterns)};
var fragmentIndexes = ${JSON.stringify(fragments.map(k=>keys.indexOf(k)))};
var fragments = [];
for(var c=0;c<fragmentIndexes.length;c++) fragments.push(keys[fragmentIndexes[c]]);
function exact(text, language) { var values = catalog[text]; return values ? values[indexes[language]] : text; }
function format(text, values, language) {
  var result = language === 'zh' || indexes[language] === undefined ? text : exact(text, language);
  for (var i = 0; i < values.length; i++) result = result.split('{' + i + '}').join(values[i] === undefined || values[i] === null ? '' : '' + values[i]);
  return result;
}
function translate(value, language) {
  var text = value === undefined || value === null ? '' : '' + value;
  if (language === 'zh' || indexes[language] === undefined || !text) return text;
  if (catalog[text]) return exact(text, language);
  // 模板中的参数始终保持原文，避免翻译客户、门店和课程名称。
  for (var p = 0; p < patterns.length; p++) {
    var pattern = patterns[p]; var parts = pattern.parts;
    if (text.indexOf(parts[0]) !== 0) continue;
    var pos = parts[0].length; var params = []; var valid = true;
    for (var n = 1; n < parts.length; n++) {
      var end = parts[n] ? text.indexOf(parts[n], pos) : text.length;
      if (end < pos) { valid = false; break; }
      params[pattern.slots[n - 1]] = text.slice(pos, end); pos = end + parts[n].length;
    }
    if (valid && pos === text.length) return format(keys[pattern.key], params, language);
  }
  // 弹窗等复合提示保留姓名和日期，只翻译已知的提示片段。
  var output = ''; var remaining = text;
  while (remaining) {
    var found = ''; var at = remaining.length;
    for (var f = 0; f < fragments.length; f++) {
      var offset = remaining.indexOf(fragments[f]);
      if (offset >= 0 && offset < at) { found = fragments[f]; at = offset; }
    }
    if (!found) { output += remaining; break; }
    output += remaining.slice(0, at) + exact(found, language); remaining = remaining.slice(at + found.length);
  }
  return output;
}
function list(values, field, language) {
  var output = [];
  for (var i = 0; i < (values || []).length; i++) {
    if (!field) output.push(translate(values[i], language));
    else { var item = { value: values[i].value, id: values[i].id, code: values[i].code }; item[field] = translate(values[i][field], language); output.push(item); }
  }
  return output;
}
`
// WXS 使用静态索引，并在取值时解析词表，避免每次模板运行重建数千条译文。
let wxsBody=body.slice(body.indexOf('function exact'))
wxsBody=wxsBody.replace('return values ? values[indexes[language]] : text;',"var word=values ? values[indexes[language]] : text; return typeof word === 'number' ? words[word] : word;").replace('keys[pattern.key]','pattern.key')
wxsBody='var catalog = '+JSON.stringify(Object.fromEntries(keys.map((key,i)=>[key,compactRows[i]])))+';\nvar words = '+JSON.stringify(words)+';\nvar indexes = { en:0,fr:1,th:2,de:3,ja:4,hi:5 };\nvar patterns = '+JSON.stringify(patterns.map(p=>({...p,key:keys[p.key]})))+';\nvar fragments = '+JSON.stringify(fragments)+';\n'+wxsBody
body = body.split('\n').map(line => line.trim()).filter(line => !line.startsWith('//')).join('\n')
fs.writeFileSync(path.join(mini, 'utils/i18n-text.js'), '// Generated by tools/sync-i18n.js\n' + body + '\nmodule.exports = { translate: translate, format: format, list: list };\n')
fs.writeFileSync(path.join(mini, 'utils/i18n.wxs'), '// Generated by tools/sync-i18n.js\n' + wxsBody + '\nmodule.exports = { t: translate, f: format, list: list };\n')
console.log('Synced ' + Object.keys(catalog).length + ' phrases in 7 languages')
